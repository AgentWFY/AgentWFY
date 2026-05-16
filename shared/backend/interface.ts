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
import type { SessionLivePatch } from '../agent/types.js'
import type { TaskOrigin } from '../task-runner/task_runner.js'

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
}

export interface SessionHandle {
  sessionId: string
}

export interface SessionsApi {
  list(req?: { limit?: number; offset?: number; since?: number; until?: number }): Promise<SessionSummary[]>
  get(req: { sessionId: string }): Promise<SessionState | null>
  spawn(req: SpawnSessionRequest): Promise<SessionHandle>
  send(req: { sessionId: string; text: string }): Promise<void>
  abort(req: { sessionId: string }): Promise<void>
  remove(req: { sessionId: string }): Promise<void>
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

export interface TasksApi {
  start(req: { taskName: string; input?: unknown; origin?: TaskOrigin }): Promise<{ runId: string }>
  stop(req: { runId: string }): Promise<void>
  listRunning(): Promise<RunningTaskSummary[]>
}

// ── Files ───────────────────────────────────────────────────────────────

// Bytes-level access to files inside the agent's filesystem (runtimeRoot for
// local agents; the daemon's per-agent dir for remote). Lets the desktop
// open file-backed tab views on remote agents without a local file mirror —
// the renderer fetches bytes lazily through this API on each load.

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

// ── Events (live stream from backend to subscribed clients) ──────────────

// Push-only: subscribers maintain a local cache and apply patches as events
// arrive. `messages` and `title` are included only when they change, so the
// conversation isn't shipped per streaming token.

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
  | { kind: 'bus'; topic: string; data: unknown }

// Subsystems publish their lifecycle changes to the event bus under known
// topics. Clients filter on topic instead of subscribing to typed event kinds.
// Convention is dotted, lowercase, scoped-by-domain — e.g. tasks.run.started.
export const BUS_TOPICS = {
  taskRunStarted:  'tasks.run.started',
  taskRunFinished: 'tasks.run.finished',
  triggersReloaded: 'triggers.reloaded',
  pluginsChanged:  'plugins.changed',
  providersChanged: 'providers.changed',
  configChanged:   'config.changed',
} as const

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
  events: EventsApi
  status: StatusApi
}
