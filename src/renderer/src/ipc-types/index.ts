export type { FilesApi } from './files.js'
export type { SqlApi } from './sql.js'
export type { TabsApi, TabViewBounds, MountTabViewRequest, UpdateTabViewBoundsRequest, DestroyTabViewRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent } from './tabs.js'
export type { SessionsApi } from './sessions.js'
export type { AuthApi } from './auth.js'
export type { StoreApi } from './store.js'
export type { DialogApi } from './dialog.js'
export type { BusApi, AgentDbChange } from './bus.js'
export type { TasksApi } from './tasks.js'

import type { FilesApi } from './files.js'
import type { SqlApi } from './sql.js'
import type { TabsApi } from './tabs.js'
import type { SessionsApi } from './sessions.js'
import type { AuthApi } from './auth.js'
import type { StoreApi } from './store.js'
import type { DialogApi } from './dialog.js'
import type { BusApi } from './bus.js'
import type { TasksApi } from './tasks.js'

import type {
  WorkerRunSqlRequest,
  WorkerGrepOptions,
  WorkerGetTabsResult,
  WorkerOpenTabRequest,
  WorkerCloseTabRequest,
  WorkerSelectTabRequest,
  WorkerReloadTabRequest,
  WorkerCaptureTabRequest,
  WorkerGetTabConsoleLogsRequest,
  WorkerExecTabJsRequest,
  WorkerTabConsoleLogEntry,
} from '../runtime/types.js'

export interface NetApi {
  headers: {
    set(request: { tid: string; headers: Record<string, string> }): Promise<void>
  }
}

export interface CommandPaletteApi {
  showFiltered(query: string): Promise<void>
}

export interface AppIpc {
  files: FilesApi
  sql: SqlApi
  tabs: TabsApi
  sessions: SessionsApi
  auth: AuthApi
  store: StoreApi
  dialog: DialogApi
  bus: BusApi
  tasks: TasksApi
  net: NetApi
  commandPalette: CommandPaletteApi
  getAgentRoot(): Promise<string | null>
  getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null>
}

export interface AgentToolsApi {
  read(path: string, offset?: number, limit?: number): Promise<string>
  write(path: string, content: string): Promise<string>
  edit(path: string, oldText: string, newText: string): Promise<string>
  ls(path?: string, limit?: number): Promise<string>
  mkdir(path: string, recursive?: boolean): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
  find(pattern: string, path?: string, limit?: number): Promise<string>
  grep(pattern: string, path?: string, options?: WorkerGrepOptions): Promise<string>
  runSql(request: WorkerRunSqlRequest): Promise<unknown>
  getTabs(): Promise<WorkerGetTabsResult>
  openTab(request: WorkerOpenTabRequest): Promise<void>
  closeTab(request: WorkerCloseTabRequest): Promise<void>
  selectTab(request: WorkerSelectTabRequest): Promise<void>
  reloadTab(request: WorkerReloadTabRequest): Promise<void>
  captureTab(request: WorkerCaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }>
  getTabConsoleLogs(request: WorkerGetTabConsoleLogsRequest): Promise<WorkerTabConsoleLogEntry[]>
  execTabJs(request: WorkerExecTabJsRequest): Promise<unknown>
  publish(topic: string, data: unknown): Promise<void>
  waitFor(topic: string, timeoutMs?: number): Promise<unknown>
  spawnAgent(prompt: string): Promise<{ agentId: string }>
  startTask(taskId: number, input?: unknown): Promise<{ runId: string }>
  stopTask(runId: string): Promise<void>
}

declare global {
  interface Window {
    ipc?: AppIpc
  }
}
