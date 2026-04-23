// IPC type schema — single source of truth for payload types across
// main process, preload, and renderer.
//
// PushMap: main → renderer (webContents.send / ipcRenderer.on)
// All type imports are `import type`, so this ESM file can be
// referenced from the CJS preload via `import type`.

import type { DisplayMessage } from '../agent/provider_types.js'
import type { RetryState } from '../agent/types.js'
import type { TabState, TabViewEvent } from '../tab-views/manager.js'
import type { ProviderState } from './providers.js'
import type { AgentDbChange } from '../db/sqlite.js'
import type { ExecJsLogEntry } from '../runtime/types.js'
import type { TaskOrigin } from '../task-runner/task_runner.js'

// ── Canonical payload types ──

export interface InstalledAgent {
  path: string
  name: string
  active: boolean
  initialized: boolean
}

export interface AgentSnapshot {
  messages: DisplayMessage[]
  isStreaming: boolean
  label: string
  streamingSessionsCount: number
  notifyOnFinish: boolean
  streamingMessage: DisplayMessage | null
  statusLine: string | undefined
  providerId: string
  activeSessionFile: string | null
  activeSessionId: string | null
  streamingFiles: string[]
  retryState: RetryState | null
  stalledSince: number | null
}

export interface AgentStreamingUpdate {
  message: DisplayMessage | null
  statusLine: string | undefined
  isStreaming: boolean
  retryState: RetryState | null
  stalledSince: number | null
}

export interface TaskRunStartedPayload {
  runId: string
  taskName: string
  title: string
  status: string
  origin: TaskOrigin
  startedAt: number
}

export interface TaskRunFinishedPayload {
  runId: string
  taskName: string
  title: string
  status: string
  origin: TaskOrigin
  startedAt: number
  finishedAt: number | undefined
  result: unknown
  error: string | undefined
  logs: ExecJsLogEntry[]
  logFile: string | null
}

export interface SidebarSwitchedPayload {
  agentRoot: string | null
  agents: InstalledAgent[]
}

// ── Push channel map (main → renderer) ──

export interface PushMap {
  'agent:snapshot': AgentSnapshot
  'agent:streaming': AgentStreamingUpdate
  'provider:state-changed': ProviderState
  'tabs:stateChanged': TabState
  'tabs:viewEvent': TabViewEvent
  'db:changed': AgentDbChange
  'zenMode:changed': boolean
  'agent-sidebar:switched': SidebarSwitchedPayload
  'tasks:runFinished': TaskRunFinishedPayload
  'tasks:runStarted': TaskRunStartedPayload
}

// ── Helper types ──

export type PushChannel = keyof PushMap
export type PushPayload<C extends PushChannel> = PushMap[C]
export type SendToRenderer = <C extends PushChannel>(channel: C, data: PushMap[C]) => void
