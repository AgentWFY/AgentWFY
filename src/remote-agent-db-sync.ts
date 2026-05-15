import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { RemoteBackend } from '#shared/backend/remote.js';
import {
  configureAgentDb,
  getAgentDbPath,
  getOrCreateAgentDb,
  replaceAgentDbSnapshotFile,
} from '#shared/db/agent-db.js';
import { parseRunSqlRequest, type RunSqlRequest } from '#shared/db/sql-router.js';
import { isPotentiallyMutatingSql, runAgentDbSql, type AgentDbChange } from '#shared/db/sqlite.js';
import { messageFromUnknown } from '#shared/backend/protocol.js';
import crypto from 'crypto';

export interface RemoteAgentDbSyncOptions {
  cacheRoot: string;
  remoteBackend: RemoteBackend;
  onLocalDbChange?: (change: AgentDbChange) => void;
}

/**
 * Maintains a desktop-local read cache of the daemon's agent DB.
 *
 * The daemon is the source of truth. Runtime SQL for remote agents is executed
 * on the daemon, and this mirror is refreshed after remote DB-change events
 * and after desktop-initiated writes. That keeps remote behavior obvious:
 * there is no local write queue, replay, or conflict resolution layer.
 */
export class RemoteAgentDbSync {
  private readonly cacheRoot: string;
  private readonly remoteBackend: RemoteBackend;
  private readonly onLocalDbChange?: (change: AgentDbChange) => void;

  private dbChangesUnsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncPromise: Promise<void> | null = null;
  private pendingRemoteChanges: AgentDbChange[] = [];
  private stopped = false;

  constructor(opts: RemoteAgentDbSyncOptions) {
    this.cacheRoot = opts.cacheRoot;
    this.remoteBackend = opts.remoteBackend;
    this.onLocalDbChange = opts.onLocalDbChange;
    configureAgentDb(this.cacheRoot, { syncSystemData: false });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(path.dirname(getAgentDbPath(this.cacheRoot)), { recursive: true });

    this.dbChangesUnsubscribe = this.remoteBackend.subscribeDbChanges((change) => {
      this.pendingRemoteChanges.push(change);
      this.scheduleSync(200);
    });
    this.statusUnsubscribe = this.remoteBackend.status.subscribe((status) => {
      if (status.state === 'connected') this.scheduleSync(0);
    });

    const hasLocalDb = fs.existsSync(getAgentDbPath(this.cacheRoot));
    try {
      await this.syncFromServer();
    } catch (err) {
      // Don't block initialization on an unreachable daemon. The status
      // subscription above will call scheduleSync(0) when the WebSocket
      // transitions to 'connected', so the first successful sync happens
      // automatically once the daemon is reachable. Until then, reads
      // against the (possibly empty) local mirror are safe — schema is
      // lazily created — and writes round-trip through the daemon and
      // will fail loudly on their own.
      console.warn(
        hasLocalDb
          ? '[remote-db-sync] initial sync failed; using existing local mirror:'
          : '[remote-db-sync] initial sync failed; agent database will sync when daemon connects:',
        messageFromUnknown(err),
      );
      this.reopenLocalDb();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.dbChangesUnsubscribe?.();
    this.statusUnsubscribe?.();
    this.dbChangesUnsubscribe = null;
    this.statusUnsubscribe = null;
  }

  async runSql(payload: unknown): Promise<unknown[]> {
    const request = parseRuntimeRunSqlRequest(payload);

    // Read-only queries against the agent DB hit the local mirror directly —
    // that's the whole point of having a mirror. The mirror is kept fresh by
    // snapshot pulls + db:changed events, and after every write below we
    // explicitly resync before returning, so a read-after-write on the same
    // client sees the write.
    //
    // sqlite-file target (and writes) always go to the daemon: the desktop
    // doesn't mirror arbitrary sqlite files, and writes must land on the
    // canonical DB so other clients see them.
    if (request.target === 'agent' && !isPotentiallyMutatingSql(request.sql)) {
      return runAgentDbSql(this.cacheRoot, {
        sql: request.sql,
        ...(request.params !== undefined ? { params: request.params } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
      });
    }

    const rows = await this.remoteBackend.invokeRemoteFunction({
      name: 'runSql',
      params: toRuntimeRunSqlParams(request),
    }) as unknown[];

    if (request.target === 'agent' && isPotentiallyMutatingSql(request.sql)) {
      await this.syncFromServer().catch((err) => {
        console.warn('[remote-db-sync] post-write sync failed:', err);
      });
    }

    return rows;
  }

  private scheduleSync(delayMs: number): void {
    if (this.stopped || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncFromServer().catch((err) => {
        console.warn('[remote-db-sync] server sync failed:', err);
      });
    }, delayMs);
  }

  private async syncFromServer(): Promise<void> {
    if (this.stopped) return;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.pullSnapshotFromServer().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async pullSnapshotFromServer(): Promise<void> {
    const snapshotPath = await this.downloadSnapshotToTempFile();
    replaceAgentDbSnapshotFile(this.cacheRoot, snapshotPath);
    this.reopenLocalDb();

    const changes = this.pendingRemoteChanges.splice(0);
    if (changes.length === 0) {
      this.onLocalDbChange?.({ table: '_database', rowId: 'snapshot', op: 'update' });
      return;
    }
    for (const change of changes) this.onLocalDbChange?.(change);
  }

  private async downloadSnapshotToTempFile(): Promise<string> {
    const { url, headers } = this.remoteBackend.getAgentDbSnapshotRequest();
    const agentDir = path.dirname(getAgentDbPath(this.cacheRoot));
    await mkdir(agentDir, { recursive: true });
    const tmpPath = path.join(agentDir, `agent.db.snapshot.${crypto.randomUUID()}.tmp`);

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`snapshot download failed: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('snapshot download failed: empty response body');
    }

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmpPath),
      );
      return tmpPath;
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  }

  private reopenLocalDb(): void {
    configureAgentDb(this.cacheRoot, { syncSystemData: false });
    const db = getOrCreateAgentDb(this.cacheRoot);
    db.setChangeListener((change) => this.onLocalDbChange?.(change));
  }
}

function parseRuntimeRunSqlRequest(payload: unknown): RunSqlRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid runSql payload: expected an object');
  }
  const raw = payload as Record<string, unknown>;
  return parseRunSqlRequest({
    target: raw.target ?? 'agent',
    path: raw.path,
    sql: raw.sql,
    params: raw.params,
    description: raw.description,
  });
}

function toRuntimeRunSqlParams(request: RunSqlRequest): Record<string, unknown> {
  return {
    target: request.target,
    path: request.path,
    sql: request.sql,
    params: request.params,
    description: request.description,
  };
}

