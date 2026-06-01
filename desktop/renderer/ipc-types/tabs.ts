export type { TabDataType, TabData, TabState, TabViewEvent } from '../../tab-view-manager.js'
import type { TabState, TabViewEvent } from '../../tab-view-manager.js'

export interface TabViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UpdateTabViewBoundsRequest {
  tabId: string
  bounds: TabViewBounds
  visible: boolean
}

export type TabContextMenuAction = 'toggle-pin' | 'reload' | null

export interface TabContextMenuRequest {
  x: number
  y: number
  tabId: string
}

export interface TabsApi {
  updateViewBounds(request: UpdateTabViewBoundsRequest): Promise<void>
  showContextMenu(request: TabContextMenuRequest): Promise<TabContextMenuAction>
  onViewEvent(callback: (detail: TabViewEvent) => void): () => void
  onStateChanged(callback: (state: TabState) => void): () => void
  getTabState(): Promise<TabState>
  getHeadlessCount(): Promise<number>
  reorderTabs(fromIndex: number, toIndex: number): Promise<void>
  togglePin(tabId: string): Promise<void>
  toggleDevTools(tabId: string): Promise<void>
  describe(): Promise<unknown>
}
