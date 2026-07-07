// Node-free task types shared by the runtime, the backend interface, and the
// TaskRunner. Split out of task_runner.ts so type-only consumers (e.g.
// runtime/types.ts, backend/interface.ts) can reference them without
// type-resolving task_runner.ts itself, which imports node:crypto + the
// node-bound JsRuntime. Keeping these here lets the Cloudflare host (no node
// types) type-check the runtime path. The TaskRunner re-exports them.

import type { ExecJsLogEntry } from '../runtime/types.js'

export type TaskOrigin =
  | { type: 'command-palette' }
  | { type: 'task-panel' }
  | { type: 'agent' }
  | { type: 'trigger'; triggerName: string; triggerType: 'schedule' | 'http' | 'event'; triggerConfig?: string }
  | { type: 'view' }
  | { type: 'shortcut' }

export type TaskRunStatus = 'running' | 'completed' | 'failed'

// Lifecycle payloads emitted by TaskRunner — defined here (not in ipc/schema.ts)
// so portable runtime code can reference them without dragging in IPC concerns.
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

export interface TaskRunLogPayload {
  runId: string
  taskName: string
  title: string
  status: TaskRunStatus
  origin: TaskOrigin
  startedAt: number
  log: ExecJsLogEntry
  logIndex: number
}

export interface TaskRunRead {
  runId: string
  taskName: string
  title: string
  status: TaskRunStatus
  origin: TaskOrigin
  input: unknown
  startedAt: number
  finishedAt: number | null
  result: unknown
  error: string | null
  logs: ExecJsLogEntry[]
}
