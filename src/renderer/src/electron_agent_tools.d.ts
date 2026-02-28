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
} from './agent/worker/types'

export interface ElectronExternalViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronMountExternalViewRequest {
  tabId: string
  viewId: string
  src: string
  bounds: ElectronExternalViewBounds
  visible: boolean
}

export interface ElectronUpdateExternalViewBoundsRequest {
  tabId: string
  bounds: ElectronExternalViewBounds
  visible: boolean
}

export interface ElectronDestroyExternalViewRequest {
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

export interface ElectronExternalViewEvent {
  tabId: string
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'
  errorCode?: number
  errorDescription?: string
}

export interface ElectronAgentDbChange {
  seq: number
  table: string
  rowId: number
  op: 'insert' | 'update' | 'delete'
  changedAt: number
}

export interface ElectronAgentDbChangedEvent {
  cursor: number
  changes: ElectronAgentDbChange[]
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
  runSql(request: WorkerRunSqlRequest): Promise<any>
  getTabs(): Promise<WorkerGetTabsResult>
  openTab(request: WorkerOpenTabRequest): Promise<void>
  closeTab(request: WorkerCloseTabRequest): Promise<void>
  selectTab(request: WorkerSelectTabRequest): Promise<void>
  reloadTab(request: WorkerReloadTabRequest): Promise<void>
  captureTab(request: WorkerCaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }>
  getTabConsoleLogs(request: WorkerGetTabConsoleLogsRequest): Promise<WorkerTabConsoleLogEntry[]>
  execTabJs(request: WorkerExecTabJsRequest): Promise<any>
  busPublish(topic: string, data: unknown): Promise<void>
  busWaitFor(topic: string, timeoutMs?: number): Promise<unknown>
  spawnAgent(prompt: string): Promise<{ agentId: string }>
}

export interface ElectronClientTools {
  openDialog(options: any): Promise<string[]>
  openUrlInDefaultBrowser(url: string): Promise<void>
  getStoreItem<T = any>(key: string): Promise<T>
  setStoreItem<T = any>(key: string, value: T): Promise<void>
  removeStoreItem(key: string): Promise<void>
  listSessions(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readSession(sessionFileName: string): Promise<string>
  writeSession(sessionFileName: string, content: string): Promise<void>
  readAuthConfig(): Promise<string>
  writeAuthConfig(content: string): Promise<void>
  readLegacyApiKey(): Promise<string>
  mountExternalView(request: ElectronMountExternalViewRequest): Promise<void>
  updateExternalViewBounds(request: ElectronUpdateExternalViewBoundsRequest): Promise<void>
  destroyExternalView(request: ElectronDestroyExternalViewRequest): Promise<void>
  showTabContextMenu(request: ElectronTabContextMenuRequest): Promise<ElectronTabContextMenuAction>
  onExternalViewEvent(callback: (detail: ElectronExternalViewEvent) => void): () => void
  onAgentDbChanged(callback: (detail: ElectronAgentDbChangedEvent) => void): () => void
  onBusForwardPublish(callback: (detail: { topic: string; data: unknown }) => void): () => void
  onBusForwardWaitFor(callback: (detail: { waiterId: string; topic: string; timeoutMs?: number }) => void): () => void
  busWaitForResolved(waiterId: string, data: unknown): void
  onAgentForwardSpawnAgent(callback: (detail: { waiterId: string; prompt: string }) => void): () => void
  agentSpawnAgentResult(waiterId: string, result: unknown): void
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
  runSql(request: WorkerRunSqlRequest): Promise<any>
  getTabs(): Promise<WorkerGetTabsResult>
  openTab(request: WorkerOpenTabRequest): Promise<void>
  closeTab(request: WorkerCloseTabRequest): Promise<void>
  selectTab(request: WorkerSelectTabRequest): Promise<void>
  reloadTab(request: WorkerReloadTabRequest): Promise<void>
  captureTab(request: WorkerCaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }>
  getTabConsoleLogs(request: WorkerGetTabConsoleLogsRequest): Promise<WorkerTabConsoleLogEntry[]>
  execTabJs(request: WorkerExecTabJsRequest): Promise<any>
  publish(topic: string, data: unknown): Promise<void>
  waitFor(topic: string, timeoutMs?: number): Promise<unknown>
  spawnAgent(prompt: string): Promise<{ agentId: string }>
}

declare global {
  interface Window {
    agentwfy?: ElectronAgentTools
    electronClientTools?: ElectronClientTools
    agentwfy?: AgentWFYViewApi
  }
}

export {}
