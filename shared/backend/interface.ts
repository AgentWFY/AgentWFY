// AgentBackend — the client-facing contract for an agent's runtime.
//
// This file must remain free of:
//   - Electron imports
//   - node:* imports
//   - DOM globals
//
// Both LocalBackend (in-process, Electron-bound) and RemoteBackend
// (WebSocket proxy, environment-neutral) implement this interface. The wire
// protocol used by RemoteBackend lives in ./protocol.ts.

import type { DisplayMessage, ProviderInfo } from '../agent/provider_types.js'
import type { FileContent, SessionLivePatch } from '../agent/types.js'
import type { TraceEvent } from '../runtime/trace_types.js'
import type {
  TaskOrigin,
  TaskRunFinishedPayload,
  TaskRunLogPayload,
  TaskRunRead,
  TaskRunStartedPayload,
} from '../task-runner/task_runner.js'
import type {
  BackupCreateResult,
  BackupRestoreResult,
  BackupStatus,
  BackupVersionInfo,
} from '../backup.js'

export type {
  BackupCreateResult,
  BackupRestoreResult,
  BackupStatus,
  BackupVersionInfo,
} from '../backup.js'

// ── Backend identity ─────────────────────────────────────────────────────

export type BackendKind = 'local' | 'remote'

export type Unsubscribe = () => void

// ── Backend connection status ───────────────────────────────────────────

export type BackendConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface BackendStatusSnapshot {
  state: BackendConnectionState
  message: string
  updatedAt: number
  reconnectAttempt?: number
  nextRetryMs?: number
}

export interface StatusApi {
  get(): BackendStatusSnapshot
  subscribe(handler: (status: BackendStatusSnapshot) => void): Unsubscribe
}

// ── Sessions ─────────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string
  title: string
  providerId: string
  updatedAt: number
}

export type { SessionLivePatch } from '../agent/types.js'

export interface SessionState extends SessionSummary {
  messages: DisplayMessage[]
  live?: SessionLivePatch | null
}

export interface SpawnSessionRequest {
  prompt: string
  providerId?: string
  providerOptions?: Record<string, unknown>
  title?: string
  files?: FileContent[]
}

export interface SessionHandle {
  sessionId: string
}

export interface SessionsApi {
  list(req?: { limit?: number; offset?: number; since?: number; until?: number }): Promise<SessionSummary[]>
  get(req: { sessionId: string }): Promise<SessionState | null>
  spawn(req: SpawnSessionRequest): Promise<SessionHandle>
  send(req: { sessionId: string; text: string; files?: FileContent[] }): Promise<void>
  abort(req: { sessionId: string }): Promise<void>
  remove(req: { sessionId: string }): Promise<void>
  /** Drop a not-yet-started queued follow-up from a session by its index. */
  removeQueued(req: { sessionId: string; index: number }): Promise<void>
}

// ── Runtime functions (the FunctionRegistry surface) ─────────────────────

export interface FunctionInfo {
  name: string
  docs?: string[]
}

export interface FunctionsApi {
  list(): Promise<FunctionInfo[]>
  invoke(req: { name: string; params: unknown }): Promise<unknown>
  /** Synchronous snapshot of visible function names. The Electron preload
   *  bridge uses sendSync to populate `window.agentwfy` before any view JS
   *  runs, so this must return without awaiting. Local backends read from
   *  the in-process registry; remote backends return a static set. */
  getNamesSync(): string[]
}

// ── Providers ───────────────────────────────────────────────────────────

export interface ProviderState {
  providerList: ProviderInfo[]
  defaultProviderId: string
  providerStatusLines: Array<[string, string]>
}

export interface ProvidersApi {
  list(): Promise<ProviderInfo[]>
  getState(): Promise<ProviderState>
  getStatusLine(providerId: string): Promise<string>
  setDefault(providerId: string): Promise<ProviderState>
}

// ── Config ──────────────────────────────────────────────────────────────

export interface ConfigApi {
  set(name: string, value: unknown): Promise<void>
  clear(name: string): Promise<void>
  remove(name: string): Promise<void>
}

// ── Tasks ───────────────────────────────────────────────────────────────

export interface RunningTaskSummary {
  runId: string
  taskName: string
  title: string
  status: string
  origin: TaskOrigin
  startedAt: number
}

export interface TaskLogHistoryItem {
  file: string
  updatedAt: number
  taskName: string
  status: string
  origin?: TaskOrigin
}

export interface TasksApi {
  start(req: { taskName: string; input?: unknown; origin?: TaskOrigin }): Promise<{ runId: string }>
  stop(req: { runId: string }): Promise<void>
  listRunning(): Promise<RunningTaskSummary[]>
  readRun(req: { runId: string }): Promise<TaskRunRead>
  listLogHistory(): Promise<TaskLogHistoryItem[]>
  /** Read a single task log file by its name (sanitized against
   *  `/^[A-Za-z0-9._-]+\.json$/`). The path is resolved inside the agent's
   *  `.agentwfy/task_logs/` directory. */
  readLog(req: { logFileName: string }): Promise<string>
}

// ── Files ───────────────────────────────────────────────────────────────

// Bytes-level access to files inside the agent's filesystem (runtimeRoot for
// local agents; the daemon's per-agent dir for remote). Used by agent-
// runtime callers that need bytes in memory (exec_js, plugins,
// window.agentwfy.read). Browser-driven asset fetches inside a view
// (`<img>`, `<video>`, etc.) do NOT go through here for remote agents —
// the URI handler returns a 302 to a signed daemon URL instead. See
// ./signed-urls.ts and desktop/protocol/file-source.ts.

export interface FilesReadResult {
  size: number
  offset: number
  content: Uint8Array
  mimeType: string
}

export interface FilesStatResult {
  exists: boolean
  size: number
  mtimeMs: number
}

export interface FilesApi {
  read(req: { path: string; offset?: number; limit?: number }): Promise<FilesReadResult>
  stat(req: { path: string }): Promise<FilesStatResult>
}

// ── Traces ──────────────────────────────────────────────────────────────

export interface TracesApi {
  list(req: { sessionId: string }): Promise<TraceEvent[]>
}

// ── Backups ─────────────────────────────────────────────────────────────

// Per-agent DB backups. Always operates on the backend's own runtime root —
// the daemon's agent dir for remote, the agent dir on disk for local. The
// local mirror cache for a remote agent is never touched by this API.

export interface BackupApi {
  create(): Promise<BackupCreateResult>
  restore(req: { version: number }): Promise<BackupRestoreResult>
  list(): Promise<BackupVersionInfo[]>
  status(): Promise<BackupStatus>
}

// ── Events (live stream from backend to subscribed clients) ──────────────

// Push-only: subscribers maintain a local cache and apply patches as events
// arrive. `messages` and `title` are included only when they change, so the
// conversation isn't shipped per streaming token. Backend lifecycle is
// carried by typed variants here, not via the agent EventBus — see
// shared/event-bus.ts.

export type AgentBackendEvent =
  | {
      kind: 'session:state'
      sessionId: string
      live: SessionLivePatch
      messages?: DisplayMessage[]
      title?: string
    }
  | { kind: 'session:created'; summary: SessionSummary }
  | { kind: 'session:removed'; sessionId: string }
  | { kind: 'session:saved'; sessionId: string }
  | { kind: 'session:loaded'; sessionId: string }
  | { kind: 'task:started'; payload: TaskRunStartedPayload }
  | { kind: 'task:log'; payload: TaskRunLogPayload }
  | { kind: 'task:finished'; payload: TaskRunFinishedPayload }

export interface EventsApi {
  subscribe(handler: (event: AgentBackendEvent) => void): Unsubscribe
}

// ── Top-level backend ────────────────────────────────────────────────────

export interface AgentBackend {
  /** Stable identifier for this backend instance (the agentId — runtime path for local, slug for remote). */
  readonly id: string
  readonly kind: BackendKind

  /** Bring the backend online (open DB, start triggers, etc.). Idempotent. */
  start(): Promise<void>
  /** Tear down (flush sessions, stop triggers, close connections). Idempotent. */
  stop(): Promise<void>

  sessions: SessionsApi
  functions: FunctionsApi
  providers: ProvidersApi
  config: ConfigApi
  tasks: TasksApi
  files: FilesApi
  traces: TracesApi
  backup: BackupApi
  events: EventsApi
  status: StatusApi
}
