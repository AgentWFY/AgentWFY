export type PageSource =
  | { type: 'view'; name: string; params?: Record<string, string> }
  | { type: 'file'; path: string; params?: Record<string, string> }
  | { type: 'url'; url: string }

export type PageViewportAlias = 'mobile' | 'tablet' | 'desktop'

export interface PageViewportSpec {
  width?: number
  height?: number
}

export interface PageViewport {
  width: number
  height: number
}

export type PageViewportInput = PageViewportAlias | PageViewportSpec

export type PageCloseAfterIdleMs = number | 'never'

export interface PageInfo {
  pageId: string
  title: string
  source: PageSource
  headless: boolean
}

export type PageHostKind =
  | 'desktop'
  | 'desktop-headless'
  | 'mobile'
  | 'daemon-headless'
  | 'remote-client'
  | 'browser-binding'

export interface PageHostInfo {
  pageId: string
  title: string
  source: PageSource
  headless: boolean
  viewport?: PageViewport
  version?: number
  closeAfterIdleMs?: PageCloseAfterIdleMs
}

export interface OpenPageRequest {
  /** Internal transport hook: daemon-hosted managers may assign the page ID
   *  before asking a remote client to create the concrete page. Public runtime
   *  helpers should omit this so the local PageManager generates IDs. */
  pageId?: string
  source: PageSource
  title?: string
  viewport?: PageViewportInput
  width?: number
  height?: number
  closeAfterIdleMs?: PageCloseAfterIdleMs
}

export interface OpenPageResult {
  pageId: string
  page: PageHostInfo
  info: string
}

export interface PageQueryRequest {
  headless?: boolean
}

export interface PageScreenshot {
  base64: string
  mimeType: 'image/png'
  pageId: string
  capturedPageId: string
  fallback?: {
    hostKind: string
    reason: string
  }
}

export interface CapturePageRequest {
  pageId: string
}

export interface PageInputRequest {
  pageId: string
  type: string
  x?: number
  y?: number
  button?: string
  clickCount?: number
  deltaX?: number
  deltaY?: number
  keyCode?: string
  modifiers?: string[]
}

export interface PageConsoleLog {
  level: string
  message: string
  timestamp: number
}

export interface PageCdpBufferedEvent {
  method: string
  params: unknown
  sessionId?: string
}

export interface PageCdpPollResult {
  events: PageCdpBufferedEvent[]
  dropped: number
  closed: boolean
}

export interface PageCdpSubscription {
  poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult>
  close(): Promise<void>
}

export interface PageApi {
  getPages(request?: PageQueryRequest): Promise<PageHostInfo[]>
  getCurrentClientPage(): Promise<PageHostInfo | null>
  openPage(request: OpenPageRequest): Promise<OpenPageResult>
  openClientPage(request: OpenPageRequest): Promise<OpenPageResult>
  closePage(request: { pageId: string }): Promise<void>
  reloadPage(request: { pageId: string }): Promise<PageHostInfo>
  capturePage(request: CapturePageRequest): Promise<PageScreenshot>
  runPageJs(request: { pageId: string; code: string; timeoutMs?: number }): Promise<unknown>
  sendPageInput(request: PageInputRequest): Promise<void>
  inspectPageElement(request: { pageId: string; selector: string }): Promise<unknown>
  getPageConsoleLogs(request: { pageId: string; since?: number; limit?: number }): Promise<PageConsoleLog[]>
  sendPageCdp(request: { pageId: string; method: string; params?: unknown; sessionId?: string }): Promise<unknown>
  subscribePageCdp(request: { pageId: string; events: string[] }): Promise<{ subscriptionId: string }>
  pollPageCdp(request: { subscriptionId: string; maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult>
  unsubscribePageCdp(request: { subscriptionId: string }): Promise<void>
  detachPageCdp(request: { pageId: string }): Promise<void>
}
