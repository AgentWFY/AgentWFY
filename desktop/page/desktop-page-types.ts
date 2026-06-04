import type { WebContentsView } from 'electron';
import type { PageCloseAfterIdleMs, PageViewport } from '#shared/page/types.js';

export type TabDataType = 'view' | 'file' | 'url'

export interface TabData {
  id: string
  tabId: string
  type: TabDataType
  title: string
  target: string | null
  headless: boolean
  viewport: PageViewport | null
  viewUpdatedAt: number | null
  viewChanged: boolean
  pinned: boolean
  selected: boolean
  params: Record<string, string> | null
  openedAt?: number
  lastUsedAt?: number
  closeAfterIdleMs?: PageCloseAfterIdleMs | null
  expiresAt?: number | null
}

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
