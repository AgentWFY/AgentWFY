import type { WebContents, WebContentsView } from 'electron';
import type { TabData, TabDataType } from '#shared/runtime/hosts.js';

export type { TabData, TabDataType } from '#shared/runtime/hosts.js';

export interface TabState {
  tabs: TabData[]
  selectedTabId: string | null
}

export interface TabViewEvent {
  tabId: string
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'
  errorCode?: number
  errorDescription?: string
}

export interface ViewConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

export interface ViewRuntimeEntry {
  webContentsId: number
  webContents: WebContents
  viewName: string
  tabId: string | null
  ownerWindowId: number | null
  lastNavigationAt: number
  lastFocusedAt: number
  logs: ViewConsoleLogEntry[]
}

export interface TabViewState {
  tabId: string
  viewName: string
  view: WebContentsView
  logs: ViewConsoleLogEntry[]
}

export type TabType = TabDataType

export interface TabViewBoundsPayload {
  x: number
  y: number
  width: number
  height: number
}

export interface TabViewSetBoundsPayload {
  tabId: string
  bounds: TabViewBoundsPayload
  visible: boolean
}

export interface TabContextMenuPayload {
  x: number
  y: number
  tabId?: string
}

export type TabContextMenuAction = 'toggle-pin' | 'reload' | 'toggle-devtools' | null;
