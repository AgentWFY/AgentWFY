export interface ElectronConsoleLogEntry {
  level: 'verbose' | 'info' | 'warning' | 'error'
  message: string
  timestamp: number
}

export interface ElectronGrepOptions {
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}

export type ElectronSqlTarget = 'agent' | 'sqlite-file'

export interface ElectronRunSqlRequest {
  target?: ElectronSqlTarget
  path?: string
  sql: string
  params?: any[]
  description?: string
  confirmed?: boolean
}

export interface ElectronCaptureViewRequest {
  viewId: string | number
}

export interface ElectronGetViewConsoleLogsRequest {
  viewId: string | number
  since?: number
  limit?: number
}

export interface ElectronExecViewJsRequest {
  viewId: string | number
  code: string
  timeoutMs?: number
}

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

export type ElectronTabContextMenuAction = 'toggle-pin' | null

export interface ElectronTabContextMenuRequest {
  x: number
  y: number
  pinned: boolean
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
  grep(pattern: string, path?: string, options?: ElectronGrepOptions): Promise<string>
  runSql(request: ElectronRunSqlRequest): Promise<any>
  captureView(request: ElectronCaptureViewRequest): Promise<{ base64: string; mimeType: 'image/png' }>
  getViewConsoleLogs(request: ElectronGetViewConsoleLogsRequest): Promise<ElectronConsoleLogEntry[]>
  execViewJs(request: ElectronExecViewJsRequest): Promise<any>
}

export interface ElectronClientTools {
  openDialog(options: any): Promise<string[]>
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
}

declare global {
  interface Window {
    electronAgentTools?: ElectronAgentTools
    electronClientTools?: ElectronClientTools
  }
}

export {}
