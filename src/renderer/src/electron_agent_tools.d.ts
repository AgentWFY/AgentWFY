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
  WorkerStartTaskResult,
} from './runtime/types'

export interface ElectronTabViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronMountTabViewRequest {
  tabId: string
  viewId: string
  src: string
  bounds: ElectronTabViewBounds
  visible: boolean
  tabType?: 'view' | 'file' | 'url'
}

export interface ElectronUpdateTabViewBoundsRequest {
  tabId: string
  bounds: ElectronTabViewBounds
  visible: boolean
}

export interface ElectronDestroyTabViewRequest {
  tabId: string
}

export type ElectronTabContextMenuAction = 'toggle-pin' | 'reload' | null

export interface ElectronTabContextMenuRequest {
  x: number
  y: number
  pinned: boolean
  viewChanged?: boolean
  tabId?: string
}

export interface ElectronTabViewEvent {
  tabId: string
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'
  errorCode?: number
  errorDescription?: string
}

export interface ElectronAgentDbChange {
  table: string
  rowId: number
  op: 'insert' | 'update' | 'delete'
}

export interface ElectronAgentTools {
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
  busPublish(topic: string, data: unknown): Promise<void>
  busWaitFor(topic: string, timeoutMs?: number): Promise<unknown>
  spawnAgent(prompt: string): Promise<{ agentId: string }>
  startTask(taskId: number): Promise<WorkerStartTaskResult>
  stopTask(runId: string): Promise<void>
}

export interface ElectronClientTools {
  openDialog(options: unknown): Promise<string[]>
  openUrlInDefaultBrowser(url: string): Promise<void>
  getStoreItem<T = unknown>(key: string): Promise<T>
  setStoreItem<T = unknown>(key: string, value: T): Promise<void>
  removeStoreItem(key: string): Promise<void>
  listSessions(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readSession(sessionFileName: string): Promise<string>
  writeSession(sessionFileName: string, content: string): Promise<void>
  readAuthConfig(): Promise<string>
  writeAuthConfig(content: string): Promise<void>
  readLegacyApiKey(): Promise<string>
  listTaskLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readTaskLog(logFileName: string): Promise<string>
  writeTaskLog(logFileName: string, content: string): Promise<void>
  mountTabView(request: ElectronMountTabViewRequest): Promise<void>
  updateTabViewBounds(request: ElectronUpdateTabViewBoundsRequest): Promise<void>
  destroyTabView(request: ElectronDestroyTabViewRequest): Promise<void>
  showTabContextMenu(request: ElectronTabContextMenuRequest): Promise<ElectronTabContextMenuAction>
  onTabViewEvent(callback: (detail: ElectronTabViewEvent) => void): () => void
  onAgentDbChanged(callback: (detail: ElectronAgentDbChange) => void): () => void
  onBusForwardPublish(callback: (detail: { topic: string; data: unknown }) => void): () => void
  onBusForwardWaitFor(callback: (detail: { waiterId: string; topic: string; timeoutMs?: number }) => void): () => void
  busWaitForResolved(waiterId: string, data: unknown): void
  onAgentForwardSpawnAgent(callback: (detail: { waiterId: string; prompt: string }) => void): () => void
  agentSpawnAgentResult(waiterId: string, result: unknown): void
  onTaskForwardInvoke(callback: (detail: { waiterId: string; method: string; params: Record<string, unknown> }) => void): () => void
  taskInvokeResult(waiterId: string, result: { ok: boolean; value?: unknown; error?: string }): void
}

export interface AgentWFYViewApi {
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
  startTask(taskId: number): Promise<WorkerStartTaskResult>
  stopTask(runId: string): Promise<void>
}

declare global {
  interface Window {
    agentwfy?: ElectronAgentTools
    electronClientTools?: ElectronClientTools
    agentwfy?: AgentWFYViewApi
  }
}

export {}
