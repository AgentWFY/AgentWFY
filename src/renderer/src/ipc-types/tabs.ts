import type {
  WorkerGetTabsResult,
  WorkerOpenTabRequest,
  WorkerCloseTabRequest,
  WorkerSelectTabRequest,
  WorkerReloadTabRequest,
  WorkerCaptureTabRequest,
  WorkerGetTabConsoleLogsRequest,
  WorkerExecTabJsRequest,
  WorkerTabConsoleLogEntry,
} from '../../../runtime/types.js'

export interface TabViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MountTabViewRequest {
  tabId: string
  viewId: string
  src: string
  bounds: TabViewBounds
  visible: boolean
  tabType?: 'view' | 'file' | 'url'
}

export interface UpdateTabViewBoundsRequest {
  tabId: string
  bounds: TabViewBounds
  visible: boolean
}

export interface DestroyTabViewRequest {
  tabId: string
}

export type TabContextMenuAction = 'toggle-pin' | 'reload' | null

export interface TabContextMenuRequest {
  x: number
  y: number
  pinned: boolean
  viewChanged?: boolean
  tabId?: string
}

export interface TabViewEvent {
  tabId: string
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'
  errorCode?: number
  errorDescription?: string
}

export interface TabsApi {
  // Agent tool operations
  getTabs(): Promise<WorkerGetTabsResult>
  openTab(request: WorkerOpenTabRequest): Promise<void>
  closeTab(request: WorkerCloseTabRequest): Promise<void>
  selectTab(request: WorkerSelectTabRequest): Promise<void>
  reloadTab(request: WorkerReloadTabRequest): Promise<void>
  captureTab(request: WorkerCaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }>
  getConsoleLogs(request: WorkerGetTabConsoleLogsRequest): Promise<WorkerTabConsoleLogEntry[]>
  execJs(request: WorkerExecTabJsRequest): Promise<unknown>
  // View management (app only)
  mountView(request: MountTabViewRequest): Promise<void>
  updateViewBounds(request: UpdateTabViewBoundsRequest): Promise<void>
  destroyView(request: DestroyTabViewRequest): Promise<void>
  showContextMenu(request: TabContextMenuRequest): Promise<TabContextMenuAction>
  onViewEvent(callback: (detail: TabViewEvent) => void): () => void
}
