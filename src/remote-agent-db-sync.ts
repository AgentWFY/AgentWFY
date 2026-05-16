import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { RemoteBackend } from '#shared/backend/remote.js';
import {
  applyAgentDbMirrorChange,
  configureAgentDb,
  getAgentDbPath,
  getOrCreateAgentDb,
  isReplicatedTable,
  replaceAgentDbSnapshotFile,
} from '#shared/db/agent-db.js';
import { parseRunSqlRequest, type RunSqlRequest } from '#shared/db/sql-router.js';
import {
  isPotentiallyMutatingSql,
  runAgentDbSql,
  type AgentDbChange,
} from '#shared/db/sqlite.js';
import { messageFromUnknown } from '#shared/backend/protocol.js';
import crypto from 'crypto';

export interface RemoteAgentDbSyncOptions {
  cacheRoot: string;
  remoteBackend: RemoteBackend;
  onLocalDbChange?: (change: AgentDbChange) => void;
  /** Fires after a snapshot wholesale-replaces the mirror — the per-row
   *  onLocalDbChange callback doesn't run for snapshot content, so any
   *  client-side state derived from the mirror needs a fresh resync here. */
  onSnapshotApplied?: () => void;
}

/**
 * Desktop-local read mirror of the daemon's agent DB.
 *
 * Sync model: the daemon is the source of truth and assigns a monotonic
 * `version` to every emitted change. The mirror tracks `localVersion` and
 * applies changes incrementally — there's no per-change snapshot download.
 *
 *   - On connect (and reconnect): fetch one snapshot. The HTTP response
 *     carries the version the snapshot reflects, which becomes `localVersion`.
 *     Pending change events with `version <= snapshotVersion` are dropped;
 *     the rest are applied in order if contiguous, otherwise a fresh
 *     snapshot is requested.
 *   - During a connected session: each `db:changed` event carries the new
 *     row data (for insert/update) or just the rowId (for delete). The
 *     mirror applies it via `applyAgentDbMirrorChange` (which bypasses the
 *     namespace guard triggers so `system.*`/`plugin.*` rows can land).
 *     A gap (`version > localVersion + 1`) or an unreplayable change
 *     (e.g. DDL, missing row data) triggers a fresh snapshot.
 *   - On a desktop-initiated mutating runSql: the daemon's RPC response
 *     includes `dbVersion`. The call awaits `localVersion >= dbVersion`
 *     before returning, so a read-after-write on the same client sees
 *     the write in the mirror.
 *
 * The interface is transport-agnostic: it asks `remoteBackend` for an
 * HTTP snapshot URL, a WS `db:changed` subscription, and an RPC that
 * returns `{value, dbVersion}`. A Cloudflare Durable Object backend
 * can implement the same surface.
 */
export class RemoteAgentDbSync {
  private readonly cacheRoot: string;
  private readonly remoteBackend: RemoteBackend;
  private readonly onLocalDbChange?: (change: AgentDbChange) => void;
  private readonly onSnapshotApplied?: () => void;

  private dbChangesUnsubscribe: (() => void) | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  private stopped = false;
  /** Version of the last change that has been applied to the mirror. */
  private localVersion = 0;
  /** True once we have a usable mirror (either from snapshot or because the
   *  existing on-disk mirror was retained). Until then, change events are
   *  buffered and applied after the first successful snapshot. */
  private initialized = false;
  /** Buffered changes received while a snapshot fetch is in flight, or
   *  before the very first snapshot completes. Drained after the snapshot
   *  is applied. */
  private buffered: AgentDbChange[] = [];
  /** When non-null, a snapshot fetch is in flight; new change events are
   *  buffered rather than applied. */
  private snapshotPromise: Promise<void> | null = null;
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented every time the WS reaches 'connected'. A snapshot that
   *  was downloading when the connection bounced has a stale `epochAtStart`
   *  and is discarded instead of clobbering the new mirror. */
  private connectionEpoch = 0;
  /** Resolvers waiting for `localVersion` to reach a given target. */
  private versionWaiters: Array<{ target: number; resolve: () => void }> = [];

  constructor(opts: RemoteAgentDbSyncOptions) {
    this.cacheRoot = opts.cacheRoot;
    this.remoteBackend = opts.remoteBackend;
    this.onLocalDbChange = opts.onLocalDbChange;
    this.onSnapshotApplied = opts.onSnapshotApplied;
    configureAgentDb(this.cacheRoot, { syncSystemData: false });
  }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(path.dirname(getAgentDbPath(this.cacheRoot)), { recursive: true });

    this.dbChangesUnsubscribe = this.remoteBackend.subscribeDbChanges((change) => {
      this.onRemoteChange(change);
    });
    this.statusUnsubscribe = this.remoteBackend.status.subscribe((status) => {
      // On every (re)connect we re-snapshot: the daemon's version counter is
      // in-memory and may have reset, and we may have missed events while
      // disconnected. Within a connected session changes apply incrementally.
      if (status.state === 'connected') {
        this.connectionEpoch += 1;
        this.initialized = false;
        this.localVersion = 0;
        this.buffered = [];
        this.clearSnapshotRetry();
        // Any in-flight snapshot from the previous connection is stale; we
        // null out the gate so a new one can start, and the stale fetch
        // discards its result via the epoch check in pullSnapshot.
        this.snapshotPromise = null;
        // Outstanding waitForVersion targets were keyed to the prior session.
        // After a daemon restart the new sequence may never reach them; resolve
        // them now and let the caller see whatever's in the next snapshot.
        for (const waiter of this.versionWaiters) waiter.resolve();
        this.versionWaiters = [];
        this.requestSnapshotInBackground();
      }
    });

    const hasLocalDb = fs.existsSync(getAgentDbPath(this.cacheRoot));
    try {
      await this.requestSnapshot();
    } catch (err) {
      // Don't block initialization on an unreachable daemon. The status
      // subscription above will trigger a snapshot once the daemon is
      // reachable. Until then, reads against the (possibly empty) local
      // mirror are safe — schema is lazily created — and writes round-trip
      // through the daemon and will fail loudly on their own.
      console.warn(
        hasLocalDb
          ? '[remote-db-sync] initial sync failed; using existing local mirror:'
          : '[remote-db-sync] initial sync failed; agent database will sync when daemon connects:',
        messageFromUnknown(err),
      );
      this.openLocalDb();
    }
  }

  stop(): void {
    this.stopped = true;
    this.dbChangesUnsubscribe?.();
    this.statusUnsubscribe?.();
    this.dbChangesUnsubscribe = null;
    this.statusUnsubscribe = null;
    this.clearSnapshotRetry();
    for (const waiter of this.versionWaiters) waiter.resolve();
    this.versionWaiters = [];
  }

  async runSql(payload: unknown): Promise<unknown[]> {
    const request = parseRuntimeRunSqlRequest(payload);

    if (request.target === 'agent' && !isPotentiallyMutatingSql(request.sql)) {
      return runAgentDbSql(this.cacheRoot, {
        sql: request.sql,
        ...(request.params !== undefined ? { params: request.params } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
      });
    }

    const response = await this.remoteBackend.invokeRemoteFunctionRaw({
      name: 'runSql',
      params: toRuntimeRunSqlParams(request),
    });

    if (request.target === 'agent' && isPotentiallyMutatingSql(request.sql)) {
      await this.waitForVersion(response.dbVersion);
    }

    return response.value as unknown[];
  }

  /** Called by `RemoteBackend` when the daemon sends `hello` with its current
   *  DB version. If the mirror is behind, schedule a snapshot. */
  onHello(dbVersion: number): void {
    if (this.stopped) return;
    if (!this.initialized) return; // start()/status handler is already on it
    if (dbVersion > this.localVersion) {
      this.requestSnapshotInBackground();
    }
  }

  // --- Internal: change dispatch ---

  private onRemoteChange(change: AgentDbChange): void {
    if (this.stopped) return;

    if (!this.initialized || this.snapshotPromise) {
      this.buffered.push(change);
      return;
    }

    switch (this.tryApply(change)) {
      case 'applied':
        this.resolveWaiters();
        this.onLocalDbChange?.(change);
        return;
      case 'duplicate':
        return;
      case 'gap':
      case 'unreplayable':
        this.buffered.push(change);
        this.requestSnapshotInBackground();
        return;
    }
  }

  /** Decide whether `change` can be applied right now and apply it if so.
   *  Caller handles the consequences (emit, buffer, resnapshot). */
  private tryApply(change: AgentDbChange): 'applied' | 'duplicate' | 'gap' | 'unreplayable' {
    if (change.version <= this.localVersion) return 'duplicate';
    if (change.version !== this.localVersion + 1) return 'gap';
    if (!this.applyChange(change)) return 'unreplayable';
    this.localVersion = change.version;
    return 'applied';
  }

  /** Apply a remote change to the mirror DB and emit nothing. Returns false
   *  if the change isn't replayable (caller should request a snapshot). */
  private applyChange(change: AgentDbChange): boolean {
    if (!isReplicatedTable(change.table)) return false;
    if (change.op !== 'delete' && !change.row) {
      // Daemon couldn't capture the row (e.g. inserted-then-deleted in
      // the same statement). Fall back to a snapshot for correctness.
      return false;
    }
    try {
      applyAgentDbMirrorChange(this.cacheRoot, change);
      return true;
    } catch (err) {
      console.warn('[remote-db-sync] applyMirrorChange failed; will resnapshot:', err);
      return false;
    }
  }

  // --- Internal: snapshot ---

  private async requestSnapshot(): Promise<void> {
    if (this.stopped) return;
    if (this.snapshotPromise) return this.snapshotPromise;
    this.clearSnapshotRetry();
    const promise = this.pullSnapshot().catch((err) => {
      this.scheduleSnapshotRetry();
      throw err;
    }).finally(() => {
      if (this.snapshotPromise === promise) {
        this.snapshotPromise = null;
      }
    });
    this.snapshotPromise = promise;
    return this.snapshotPromise;
  }

  private requestSnapshotInBackground(): void {
    void this.requestSnapshot().catch((err) => {
      if (!this.stopped) {
        console.warn('[remote-db-sync] snapshot sync failed; will retry:', messageFromUnknown(err));
      }
    });
  }

  private scheduleSnapshotRetry(): void {
    if (this.stopped || this.snapshotRetryTimer) return;
    if (this.remoteBackend.status.get().state !== 'connected') return;
    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = null;
      this.requestSnapshotInBackground();
    }, 1000);
  }

  private clearSnapshotRetry(): void {
    if (!this.snapshotRetryTimer) return;
    clearTimeout(this.snapshotRetryTimer);
    this.snapshotRetryTimer = null;
  }

  private async pullSnapshot(): Promise<void> {
    const epochAtStart = this.connectionEpoch;
    const { snapshotPath, version } = await this.downloadSnapshotToTempFile();
    if (this.stopped || this.connectionEpoch !== epochAtStart) {
      // The WS bounced (or we stopped) while this snapshot was downloading.
      // Drop it on the floor; the post-reconnect requestSnapshot will pull
      // a fresh one keyed to the new epoch.
      fs.rmSync(snapshotPath, { force: true });
      return;
    }
    replaceAgentDbSnapshotFile(this.cacheRoot, snapshotPath);
    this.openLocalDb();
    this.localVersion = version;
    this.initialized = true;

    // Drain buffered changes. Daemon emits sequentially over a single WS
    // connection so version order matches arrival order — no sort needed.
    // A gap (or unreplayable change) re-buffers from that point on and we
    // schedule another snapshot once this one settles.
    const pending = this.buffered;
    this.buffered = [];

    let needReSnapshot = false;
    for (const change of pending) {
      if (needReSnapshot) {
        this.buffered.push(change);
        continue;
      }
      const result = this.tryApply(change);
      if (result === 'applied' || (result === 'duplicate' && isReplicatedTable(change.table))) {
        this.onLocalDbChange?.(change);
      } else if (result === 'gap' || result === 'unreplayable') {
        needReSnapshot = true;
        this.buffered.push(change);
      }
    }

    this.resolveWaiters();

    if (needReSnapshot) {
      // Schedule outside this call so snapshotPromise can clear first.
      queueMicrotask(() => this.requestSnapshotInBackground());
    }

    this.onSnapshotApplied?.();
  }

  private async downloadSnapshotToTempFile(): Promise<{ snapshotPath: string; version: number }> {
    const { url, headers, versionHeader } = this.remoteBackend.getAgentDbSnapshotRequest();
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

    const rawVersion = response.headers.get(versionHeader);
    const version = rawVersion === null ? 0 : Number(rawVersion);
    if (!Number.isFinite(version) || version < 0) {
      throw new Error(`snapshot download failed: invalid ${versionHeader} header: ${rawVersion}`);
    }

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmpPath),
      );
      return { snapshotPath: tmpPath, version };
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  }

  private openLocalDb(): void {
    configureAgentDb(this.cacheRoot, { syncSystemData: false });
    // Materialize the connection so subsequent reads don't race against the
    // file rename done by replaceAgentDbSnapshotFile. We deliberately do NOT
    // attach a change listener: the mirror is a passive follower, and we
    // emit AgentDbChange events manually with the daemon's original version.
    getOrCreateAgentDb(this.cacheRoot);
  }

  // --- Internal: version waiters ---

  private waitForVersion(target: number): Promise<void> {
    if (this.stopped || this.localVersion >= target) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.versionWaiters.push({ target, resolve });
    });
  }

  private resolveWaiters(): void {
    if (this.versionWaiters.length === 0) return;
    const remaining: Array<{ target: number; resolve: () => void }> = [];
    for (const waiter of this.versionWaiters) {
      if (this.localVersion >= waiter.target) waiter.resolve();
      else remaining.push(waiter);
    }
    this.versionWaiters = remaining;
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
