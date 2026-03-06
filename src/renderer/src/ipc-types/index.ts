export type { FilesApi } from './files'
export type { SqlApi } from './sql'
export type { TabsApi, TabViewBounds, MountTabViewRequest, UpdateTabViewBoundsRequest, DestroyTabViewRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent } from './tabs'
export type { SessionsApi } from './sessions'
export type { AuthApi } from './auth'
export type { StoreApi } from './store'
export type { DialogApi } from './dialog'
export type { BusApi, AgentDbChange } from './bus'
export type { TasksApi } from './tasks'

import type { FilesApi } from './files'
import type { SqlApi } from './sql'
import type { TabsApi } from './tabs'
import type { SessionsApi } from './sessions'
import type { AuthApi } from './auth'
import type { StoreApi } from './store'
import type { DialogApi } from './dialog'
import type { BusApi } from './bus'
import type { TasksApi } from './tasks'

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
} from '../runtime/types'

export interface NetApi {
  headers: {
    set(request: { tid: string; headers: Record<string, string> }): Promise<void>
  }
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
  startTask(taskId: number): Promise<{ runId: string }>
  stopTask(runId: string): Promise<void>
}

declare global {
  interface Window {
    ipc?: AppIpc
    agentwfy?: AgentToolsApi
  }
}

export {}
