import type {
  BrowserCdpSubscription,
  BrowserHost,
  BrowserOpenRequest,
  BrowserPageHandle,
  TabConsoleLog,
  TabDebuggerPollResult,
  Viewport,
} from '#shared/runtime/hosts.js'
import type { TabViewManager } from '../tab-views/manager.js'

export class ElectronBrowserHost implements BrowserHost {
  constructor(private readonly tabViewManager: TabViewManager) {}

  async openPage(request: BrowserOpenRequest): Promise<BrowserPageHandle> {
    const result = await this.tabViewManager.openTabHandler({
      viewName: request.viewName,
      filePath: request.filePath,
      url: request.url,
      title: request.title,
      headless: true,
      viewport: request.viewport,
      params: request.params,
    })
    const page = this.getPage(result.tabId)
    if (!page) {
      throw new Error(`Failed to create headless page for tabId "${result.tabId}"`)
    }
    return page
  }

  async closePage(tabId: string): Promise<void> {
    await this.tabViewManager.closeTabHandler({ tabId })
  }

  getPage(tabId: string): BrowserPageHandle | null {
    const tab = this.tabViewManager.getTabData(tabId)
    if (!tab?.headless || !tab.viewport) return null
    return new ElectronBrowserPageHandle(this.tabViewManager, tabId, tab.viewport)
  }
}

class ElectronBrowserPageHandle implements BrowserPageHandle {
  readonly tabId: string
  readonly viewport: Viewport

  constructor(
    private readonly tabViewManager: TabViewManager,
    tabId: string,
    viewport: Viewport,
  ) {
    this.tabId = tabId
    this.viewport = viewport
  }

  async sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    return this.tabViewManager.tabDebuggerSendById({
      tabId: this.tabId,
      method,
      params,
      sessionId,
    })
  }

  subscribeCdp(events: string[]): BrowserCdpSubscription {
    const subscriptionId = `browser-${this.tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.tabViewManager.tabDebuggerSubscribeById({
      tabId: this.tabId,
      subscriptionId,
      events,
    })
    return {
      poll: (request?: { maxBatch?: number; maxWaitMs?: number }): Promise<TabDebuggerPollResult> => {
        return this.tabViewManager.tabDebuggerPollById({
          subscriptionId,
          maxBatch: request?.maxBatch,
          maxWaitMs: request?.maxWaitMs,
        })
      },
      close: async (): Promise<void> => {
        this.tabViewManager.tabDebuggerUnsubscribeById(subscriptionId)
      },
    }
  }

  getConsoleLogs(request?: { since?: number; limit?: number }): Promise<TabConsoleLog[]> {
    return this.tabViewManager.getTabConsoleLogsById({
      tabId: this.tabId,
      since: request?.since,
      limit: request?.limit,
    })
  }
}
