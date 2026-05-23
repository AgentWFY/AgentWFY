// Mobile read-mirror of the daemon's agent DB.
//
// Implements the RemoteDbSync seam from #shared/backend/remote.js. The state
// machine here is a near-direct port of desktop/remote-agent-db-sync.ts —
// version tracking, buffered queue, snapshot epochs, version waiters, gap
// detection, hello/reset — with two differences:
//
//   1. Local SQLite IO goes through Tauri commands (bridge.mirrorDb.*) so the
//      file lives on the iOS/Android sandbox and the connection is owned by
//      Rust.
//   2. Snapshot download uses fetch().arrayBuffer() instead of Node streams.
//
// All inter-IO calls are async; the desktop version is mostly sync. Otherwise
// the surface and protocol are identical, so the mirror reconnects + recovers
// the same way.

import type { RemoteBackend, RemoteDbSync } from '#shared/backend/remote.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'
import { isPotentiallyMutatingSql } from '#shared/db/sql-introspect.js'
import { bridge } from './tauri-bridge.js'

export interface MobileRemoteMirrorOptions {
  agentId: string
  remoteBackend: RemoteBackend
  onLocalDbChange?: (change: AgentDbChange) => void
  onSnapshotApplied?: () => void
}

interface RunSqlPayload {
  target?: 'agent' | 'sqlite-file'
  sql: unknown
  params?: unknown
  description?: unknown
  path?: unknown
}

export class MobileRemoteMirror implements RemoteDbSync {
  private readonly agentId: string
  private readonly remoteBackend: RemoteBackend
  private readonly onLocalDbChange?: (change: AgentDbChange) => void
  private readonly onSnapshotApplied?: () => void

  private dbChangesUnsubscribe: (() => void) | null = null
  private statusUnsubscribe: (() => void) | null = null
  private stopped = false
  private localVersion = 0
  private initialized = false
  private buffered: AgentDbChange[] = []
  private snapshotPromise: Promise<void> | null = null
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null
  private connectionEpoch = 0
  private versionWaiters: Array<{ target: number; resolve: () => void }> = []

  constructor(opts: MobileRemoteMirrorOptions) {
    this.agentId = opts.agentId
    this.remoteBackend = opts.remoteBackend
    this.onLocalDbChange = opts.onLocalDbChange
    this.onSnapshotApplied = opts.onSnapshotApplied
  }

  async start(): Promise<void> {
    this.stopped = false

    this.dbChangesUnsubscribe = this.remoteBackend.subscribeDbChanges((change) => {
      this.onRemoteChange(change)
    })
    this.statusUnsubscribe = this.remoteBackend.status.subscribe((status) => {
      // Re-snapshot on every (re)connect: the daemon's version counter is
      // in-memory and may have reset, and we may have missed events while
      // disconnected. Within a connected session, changes apply incrementally.
      if (status.state === 'connected') {
        this.resetMirrorState()
        this.requestSnapshotInBackground()
      }
    })

    const open = await bridge.mirrorDb.open(this.agentId).catch(() => ({ status: 'not_initialized' as const }))
    try {
      await this.requestSnapshot()
    } catch (err) {
      console.warn(
        open.status === 'ready'
          ? '[mobile-mirror] initial sync failed; using existing local mirror:'
          : '[mobile-mirror] initial sync failed; agent database will sync when daemon connects:',
        messageFromUnknown(err),
      )
    }
  }

  stop(): void {
    this.stopped = true
    this.dbChangesUnsubscribe?.()
    this.statusUnsubscribe?.()
    this.dbChangesUnsubscribe = null
    this.statusUnsubscribe = null
    this.clearSnapshotRetry()
    for (const waiter of this.versionWaiters) waiter.resolve()
    this.versionWaiters = []
  }

  async runSql(payload: unknown): Promise<unknown[]> {
    const request = parseRunSqlPayload(payload)

    if (request.target === 'agent' && !isPotentiallyMutatingSql(request.sql)) {
      // Read-only against the local mirror — no daemon round-trip.
      return bridge.mirrorDb.query(this.agentId, request.sql, request.params ?? [])
    }

    const response = await this.remoteBackend.invokeRemoteFunctionRaw({
      name: 'runSql',
      params: {
        target: request.target,
        ...(request.path !== undefined ? { path: request.path } : {}),
        sql: request.sql,
        ...(request.params !== undefined ? { params: request.params } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
      },
    })

    if (request.target === 'agent' && isPotentiallyMutatingSql(request.sql)) {
      await this.waitForVersion(response.dbVersion)
    }
    return response.value as unknown[]
  }

  onHello(dbVersion: number): void {
    if (this.stopped) return
    if (!this.initialized) return // start()/status handler is already on it
    if (dbVersion > this.localVersion) {
      this.requestSnapshotInBackground()
    }
  }

  onReset(): void {
    if (this.stopped) return
    this.resetMirrorState()
    this.requestSnapshotInBackground()
  }

  private resetMirrorState(): void {
    this.connectionEpoch += 1
    this.initialized = false
    this.localVersion = 0
    this.buffered = []
    this.clearSnapshotRetry()
    this.snapshotPromise = null
    for (const waiter of this.versionWaiters) waiter.resolve()
    this.versionWaiters = []
  }

  // ── Change dispatch ──────────────────────────────────────────────

  private onRemoteChange(change: AgentDbChange): void {
    if (this.stopped) return

    if (!this.initialized || this.snapshotPromise) {
      this.buffered.push(change)
      return
    }

    void this.dispatchChange(change)
  }

  private async dispatchChange(change: AgentDbChange): Promise<void> {
    const result = await this.tryApply(change)
    if (this.stopped) return
    switch (result) {
      case 'applied':
        this.resolveWaiters()
        this.onLocalDbChange?.(change)
        return
      case 'duplicate':
        return
      case 'gap':
      case 'unreplayable':
        this.buffered.push(change)
        this.requestSnapshotInBackground()
        return
    }
  }

  private async tryApply(change: AgentDbChange): Promise<'applied' | 'duplicate' | 'gap' | 'unreplayable'> {
    if (change.version <= this.localVersion) return 'duplicate'
    if (change.version !== this.localVersion + 1) return 'gap'
    const applied = await this.applyChange(change)
    if (!applied) return 'unreplayable'
    // Re-check after the await: a reset/snapshot could have run during the
    // Tauri round-trip and moved localVersion. The Rust write may have been
    // overwritten by a subsequent snapshot replace — the snapshot wins, so
    // treat this as a no-op rather than advancing localVersion past the
    // snapshot's authoritative position.
    if (this.stopped) return 'duplicate'
    if (change.version !== this.localVersion + 1) return 'duplicate'
    this.localVersion = change.version
    return 'applied'
  }

  private async applyChange(change: AgentDbChange): Promise<boolean> {
    if (!CHANGE_TRACKED_TABLES.has(change.table)) return false
    if (change.op !== 'delete' && !change.row) {
      // Daemon couldn't capture the row (e.g. inserted-then-deleted in the
      // same statement). Fall back to a snapshot for correctness.
      return false
    }
    try {
      await bridge.mirrorDb.applyChange(this.agentId, change)
      return true
    } catch (err) {
      console.warn('[mobile-mirror] applyChange failed; will resnapshot:', err)
      return false
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────

  private async requestSnapshot(): Promise<void> {
    if (this.stopped) return
    if (this.snapshotPromise) return this.snapshotPromise
    this.clearSnapshotRetry()
    const promise = this.pullSnapshot()
      .catch((err) => {
        this.scheduleSnapshotRetry()
        throw err
      })
      .finally(() => {
        if (this.snapshotPromise === promise) {
          this.snapshotPromise = null
        }
      })
    this.snapshotPromise = promise
    return this.snapshotPromise
  }

  private requestSnapshotInBackground(): void {
    void this.requestSnapshot().catch((err) => {
      if (!this.stopped) {
        console.warn('[mobile-mirror] snapshot sync failed; will retry:', messageFromUnknown(err))
      }
    })
  }

  private scheduleSnapshotRetry(): void {
    if (this.stopped || this.snapshotRetryTimer) return
    if (this.remoteBackend.status.get().state !== 'connected') return
    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = null
      this.requestSnapshotInBackground()
    }, 1000)
  }

  private clearSnapshotRetry(): void {
    if (!this.snapshotRetryTimer) return
    clearTimeout(this.snapshotRetryTimer)
    this.snapshotRetryTimer = null
  }

  private async pullSnapshot(): Promise<void> {
    const epochAtStart = this.connectionEpoch
    const { bytes, version } = await this.downloadSnapshot()
    if (this.stopped || this.connectionEpoch !== epochAtStart) {
      // The WS bounced (or we stopped) while this snapshot was downloading.
      // Drop it on the floor; the post-reconnect requestSnapshot will pull
      // a fresh one keyed to the new epoch.
      return
    }
    await bridge.mirrorDb.replaceSnapshot(this.agentId, bytes)
    // Re-check after the replaceSnapshot await: a reset (reconnect) could
    // have fired while the Tauri command was in flight, in which case we
    // must NOT clobber the freshly-reset state. The new epoch's snapshot
    // is now in charge.
    if (this.stopped || this.connectionEpoch !== epochAtStart) return
    this.localVersion = version
    this.initialized = true

    // Drain buffered changes. Daemon emits sequentially over a single WS
    // connection so version order matches arrival order — no sort needed.
    const pending = this.buffered
    this.buffered = []

    let needReSnapshot = false
    for (const change of pending) {
      if (needReSnapshot) {
        this.buffered.push(change)
        continue
      }
      const result = await this.tryApply(change)
      if (result === 'applied' || (result === 'duplicate' && CHANGE_TRACKED_TABLES.has(change.table))) {
        this.onLocalDbChange?.(change)
      } else if (result === 'gap' || result === 'unreplayable') {
        needReSnapshot = true
        this.buffered.push(change)
      }
    }

    this.resolveWaiters()

    if (needReSnapshot) {
      queueMicrotask(() => this.requestSnapshotInBackground())
    }

    this.onSnapshotApplied?.()
  }

  private async downloadSnapshot(): Promise<{ bytes: Uint8Array; version: number }> {
    const { url, headers, versionHeader } = this.remoteBackend.getAgentDbSnapshotRequest()
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`snapshot download failed: HTTP ${response.status}`)
    }
    const rawVersion = response.headers.get(versionHeader)
    const version = rawVersion === null ? 0 : Number(rawVersion)
    if (!Number.isFinite(version) || version < 0) {
      throw new Error(`snapshot download failed: invalid ${versionHeader} header: ${rawVersion}`)
    }
    const buffer = await response.arrayBuffer()
    return { bytes: new Uint8Array(buffer), version }
  }

  // ── Version waiters ───────────────────────────────────────────────

  private waitForVersion(target: number): Promise<void> {
    if (this.stopped || this.localVersion >= target) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.versionWaiters.push({ target, resolve })
    })
  }

  private resolveWaiters(): void {
    if (this.versionWaiters.length === 0) return
    const remaining: Array<{ target: number; resolve: () => void }> = []
    for (const waiter of this.versionWaiters) {
      if (this.localVersion >= waiter.target) waiter.resolve()
      else remaining.push(waiter)
    }
    this.versionWaiters = remaining
  }
}

const CHANGE_TRACKED_TABLES = new Set([
  'views',
  'docs',
  'tasks',
  'triggers',
  'config',
  'plugins',
  'modules',
])

interface ParsedRunSql {
  target: 'agent' | 'sqlite-file'
  sql: string
  params?: unknown[]
  description?: string
  path?: string
}

function parseRunSqlPayload(payload: unknown): ParsedRunSql {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid runSql payload: expected an object')
  }
  const raw = payload as RunSqlPayload
  const target = raw.target ?? 'agent'
  if (target !== 'agent' && target !== 'sqlite-file') {
    throw new Error('Invalid runSql payload: target must be "agent" or "sqlite-file"')
  }
  if (typeof raw.sql !== 'string' || raw.sql.trim().length === 0) {
    throw new Error('Invalid runSql payload: sql must be a non-empty string')
  }
  if (typeof raw.params !== 'undefined' && !Array.isArray(raw.params)) {
    throw new Error('Invalid runSql payload: params must be an array when provided')
  }
  if (typeof raw.path !== 'undefined' && typeof raw.path !== 'string') {
    throw new Error('Invalid runSql payload: path must be a string when provided')
  }
  if (typeof raw.description !== 'undefined' && typeof raw.description !== 'string') {
    throw new Error('Invalid runSql payload: description must be a string when provided')
  }
  const out: ParsedRunSql = { target, sql: raw.sql }
  if (raw.params !== undefined) out.params = raw.params as unknown[]
  if (raw.description !== undefined) out.description = raw.description as string
  if (raw.path !== undefined) out.path = raw.path as string
  return out
}
