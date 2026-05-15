// IPC type schema — single source of truth for payload types across
// main process, preload, and renderer.
//
// PushMap: main → renderer (webContents.send / ipcRenderer.on)
// All type imports are `import type`, so this ESM file can be
// referenced from the CJS preload via `import type`.

import type { TabState, TabViewEvent } from '../tab-views/manager.js'
import type { ProviderState } from './providers.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import type { AgentSnapshot, SessionLivePatch } from '#shared/agent/types.js'
import type { BackendConnectionState } from '#shared/backend/interface.js'
import type {
  TaskRunStartedPayload,
  TaskRunFinishedPayload,
} from '#shared/task-runner/task_runner.js'

// Re-exported from portable locations so renderer/preload imports continue to
// resolve through ipc/schema as before.
export type { AgentSnapshot, SessionLivePatch } from '#shared/agent/types.js'
export type {
  TaskRunStartedPayload,
  TaskRunFinishedPayload,
} from '#shared/task-runner/task_runner.js'

// ── Canonical payload types ──

export interface InstalledAgent {
  agentId: string
  name: string
  active: boolean
  initialized: boolean
  /** 'local' for in-process agents, 'remote' for daemon-backed agents. */
  backend: 'local' | 'remote'
  /** Present for daemon-backed agents so the sidebar can show connection health. */
  remoteStatus?: BackendConnectionState
  remoteStatusText?: string
}

export interface SidebarSwitchedPayload {
  agentId: string | null
  agents: InstalledAgent[]
}

export interface SettingChangedPayload {
  key: string
  value: unknown
}

// ── Push channel map (main → renderer) ──

export interface PushMap {
  'agent:snapshot': AgentSnapshot
  'agent:streaming': SessionLivePatch
  'provider:state-changed': ProviderState
  'tabs:stateChanged': TabState
  'tabs:viewEvent': TabViewEvent
  'db:changed': AgentDbChange
  'zenMode:changed': boolean
  'agent-sidebar:switched': SidebarSwitchedPayload
  'tasks:runFinished': TaskRunFinishedPayload
  'tasks:runStarted': TaskRunStartedPayload
  'app:settingChanged': SettingChangedPayload
}

// ── Helper types ──

export type PushChannel = keyof PushMap
export type PushPayload<C extends PushChannel> = PushMap[C]
export type SendToRenderer = <C extends PushChannel>(channel: C, data: PushMap[C]) => void
