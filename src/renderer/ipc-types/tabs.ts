export interface TabViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MountTabViewRequest {
  tabId: string
  viewName: string
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

export type TabDataType = 'view' | 'file' | 'url'

export interface TabData {
  id: string
  type: TabDataType
  title: string
  target: string
  viewUpdatedAt?: number | null
  viewChanged: boolean
  pinned: boolean
  hidden: boolean
  params?: Record<string, string>
}

export interface TabState {
  tabs: TabData[]
  selectedTabId: string | null
}

export interface TabsApi {
  openTab(request: unknown): Promise<{ tabId: string }>
  closeTab(request: unknown): Promise<void>
  selectTab(request: unknown): Promise<void>
  mountView(request: MountTabViewRequest): Promise<void>
  updateViewBounds(request: UpdateTabViewBoundsRequest): Promise<void>
  destroyView(request: DestroyTabViewRequest): Promise<void>
  showContextMenu(request: TabContextMenuRequest): Promise<TabContextMenuAction>
  onViewEvent(callback: (detail: TabViewEvent) => void): () => void
  // Tab state sync (main → renderer)
  onStateChanged(callback: (state: TabState) => void): () => void
  getTabState(): Promise<TabState>
  reorderTabs(fromIndex: number, toIndex: number): Promise<void>
  togglePin(tabId: string): Promise<void>
  revealTab(tabId: string): Promise<void>
}
