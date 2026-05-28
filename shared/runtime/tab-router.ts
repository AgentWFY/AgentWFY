import type { ClientFunctionInvoker } from './client-functions.js'
import type {
  BrowserCdpSubscription,
  BrowserHost,
  BrowserOpenRequest,
  BrowserPageHandle,
  TabApi,
  TabCaptureResult,
  TabConsoleLog,
  TabData,
  TabDebuggerPollResult,
  TabOpenRequest,
  TabSendInputRequest,
  VisibleTabHost,
} from './hosts.js'
import {
  capture as captureWithCdp,
  dispatchInput,
  execJs as execJsWithCdp,
  getConsoleLogs as getConsoleLogsWithCdp,
  inspect as inspectWithCdp,
  isNotAttachedError,
} from '../browser/cdp-ops.js'

const RELOAD_RETRY_BUDGET_MS = 3000

type RoutedBackend = 'browser' | 'visible' | 'client'

interface TabRouterOptions {
  visibleTabHost?: VisibleTabHost
  browserHost?: BrowserHost
  clientInvoker?: ClientFunctionInvoker
}

export class TabRouter implements TabApi {
  private readonly visibleTabHost: VisibleTabHost | undefined
  private readonly browserHost: BrowserHost | undefined
  private readonly clientInvoker: ClientFunctionInvoker | undefined
  private readonly tabBackends = new Map<string, RoutedBackend>()
  private readonly browserSubscriptions = new Map<string, BrowserCdpSubscription>()
  private readonly browserSubscriptionTabs = new Map<string, string>()

  constructor(options: TabRouterOptions) {
    this.visibleTabHost = options.visibleTabHost
    this.browserHost = options.browserHost
    this.clientInvoker = options.clientInvoker
  }

  async getTabs(): Promise<TabData[]> {
    const tabs: TabData[] = []
    if (this.visibleTabHost) {
      tabs.push(...await this.visibleTabHost.getTabs())
    } else if (this.clientInvoker) {
      try {
        tabs.push(...normalizeTabs(await this.clientInvoker.invokeClientFunction('getTabs', {})))
      } catch {
        // Remote daemons can still report headless tabs when no client is connected.
      }
    }

    if (this.browserHost?.getTabs) {
      const existing = new Set(tabs.map(tab => tab.tabId || tab.id))
      for (const tab of await this.browserHost.getTabs()) {
        const id = tab.tabId || tab.id
        if (!existing.has(id)) tabs.push(tab)
      }
    }

    for (const tab of tabs) {
      const id = tab.tabId || tab.id
      if (!id) continue
      if (tab.headless) {
        this.tabBackends.set(id, 'browser')
      } else if (!this.tabBackends.has(id)) {
        this.tabBackends.set(id, this.visibleTabHost ? 'visible' : 'client')
      }
    }

    return tabs
  }

  async getCurrentTab(): Promise<TabData | null> {
    if (this.visibleTabHost) {
      return this.visibleTabHost.getCurrentTab()
    }
    if (!this.clientInvoker) return null
    try {
      return normalizeTabOrNull(await this.clientInvoker.invokeClientFunction('getCurrentTab', {}))
    } catch {
      return null
    }
  }

  async openTab(request: TabOpenRequest): Promise<{ tabId: string }> {
    if (typeof request.headless !== 'boolean') {
      throw new Error('openTab requires headless to be set by the runtime binding')
    }

    if (request.headless) {
      if (!this.browserHost) {
        throw new Error(
          'Headless tab host is not available in this runtime. A remote daemon ' +
          'needs a Chrome to drive headless tabs: set AGENTWFY_BROWSER_EXECUTABLE ' +
          '(path to a Chrome/Chromium binary) or AGENTWFY_BROWSER_CDP_URL (an ' +
          'existing CDP endpoint). To open a visible tab on a connected client ' +
          'instead, pass headless:false.',
        )
      }
      const handle = await this.browserHost.openPage(request as BrowserOpenRequest)
      this.tabBackends.set(handle.tabId, 'browser')
      return { tabId: handle.tabId }
    }

    const result = await this.callVisible<{ tabId: string }>('openTab', request)
    this.tabBackends.set(result.tabId, this.visibleTabHost ? 'visible' : 'client')
    return result
  }

  async closeTab(request: { tabId: string }): Promise<void> {
    if (this.isBrowserTab(request.tabId)) {
      await this.browserHost?.closePage(request.tabId)
      this.unregister(request.tabId)
      return
    }
    await this.callVisible<void>('closeTab', request)
    this.unregister(request.tabId)
  }

  async selectTab(request: { tabId: string }): Promise<void> {
    if (this.isBrowserTab(request.tabId)) {
      return
    }
    await this.callVisible<void>('selectTab', request)
  }

  async reloadTab(request: { tabId: string }): Promise<void> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      // Mirror captureWithCdp's retry: a reload issued right after openTab can
      // race the navigation and fail with "Not attached to an active page".
      const deadline = Date.now() + RELOAD_RETRY_BUDGET_MS
      while (true) {
        try {
          await handle.sendCdp('Page.reload')
          return
        } catch (err) {
          if (!isNotAttachedError(err) || Date.now() >= deadline) throw err
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
      }
    }
    await this.callVisible<void>('reloadTab', request)
  }

  async captureTab(request: { tabId: string }): Promise<TabCaptureResult> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      return captureWithCdp(handle)
    }
    return this.callVisible<TabCaptureResult>('captureTab', request)
  }

  async getTabConsoleLogs(request: { tabId: string; since?: number; limit?: number }): Promise<TabConsoleLog[]> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      return getConsoleLogsWithCdp(handle, request)
    }
    return this.callVisible<TabConsoleLog[]>('getTabConsoleLogs', request)
  }

  async execTabJs(request: { tabId: string; code: string; timeoutMs?: number }): Promise<unknown> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      return execJsWithCdp(handle, request.code, request.timeoutMs)
    }
    return this.callVisible<unknown>('execTabJs', request)
  }

  async sendInput(request: TabSendInputRequest): Promise<void> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      await dispatchInput(handle, request)
      return
    }
    await this.callVisible<void>('sendInput', request)
  }

  async inspectElement(request: { tabId: string; selector: string }): Promise<unknown> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      return inspectWithCdp(handle, request.selector)
    }
    return this.callVisible<unknown>('inspectElement', request)
  }

  async tabDebuggerSend(request: { tabId: string; method: string; params?: unknown; sessionId?: string }): Promise<unknown> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      return handle.sendCdp(request.method, request.params, request.sessionId)
    }
    return this.callVisible<unknown>('tabDebuggerSend', request)
  }

  async tabDebuggerSubscribe(request: { tabId: string; subscriptionId: string; events: string[] }): Promise<void> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      const sub = handle.subscribeCdp(request.events)
      this.browserSubscriptions.set(request.subscriptionId, sub)
      this.browserSubscriptionTabs.set(request.subscriptionId, request.tabId)
      return
    }
    await this.callVisible<void>('tabDebuggerSubscribe', request)
  }

  async tabDebuggerPoll(
    request: { subscriptionId: string; maxBatch?: number; maxWaitMs?: number },
  ): Promise<TabDebuggerPollResult> {
    const sub = this.browserSubscriptions.get(request.subscriptionId)
    if (sub) {
      const result = await sub.poll(request)
      if (result.closed) {
        this.browserSubscriptions.delete(request.subscriptionId)
        this.browserSubscriptionTabs.delete(request.subscriptionId)
      }
      return result
    }
    return this.callVisible<TabDebuggerPollResult>('tabDebuggerPoll', request)
  }

  async tabDebuggerUnsubscribe(request: { subscriptionId: string }): Promise<void> {
    const sub = this.browserSubscriptions.get(request.subscriptionId)
    if (sub) {
      this.browserSubscriptions.delete(request.subscriptionId)
      this.browserSubscriptionTabs.delete(request.subscriptionId)
      await sub.close()
      return
    }
    await this.callVisible<void>('tabDebuggerUnsubscribe', request)
  }

  async tabDebuggerDetach(request: { tabId: string }): Promise<void> {
    const handle = this.getBrowserPage(request.tabId)
    if (handle) {
      await handle.sendCdp('Runtime.disable').catch(() => {})
      this.closeBrowserSubscriptionsForTab(request.tabId)
      return
    }
    await this.callVisible<void>('tabDebuggerDetach', request)
  }

  register(tabId: string, backend: RoutedBackend): void {
    this.tabBackends.set(tabId, backend)
  }

  unregister(tabId: string): void {
    this.tabBackends.delete(tabId)
    this.closeBrowserSubscriptionsForTab(tabId)
  }

  private closeBrowserSubscriptionsForTab(tabId: string): void {
    for (const [id, sub] of this.browserSubscriptions) {
      if (this.browserSubscriptionTabs.get(id) !== tabId) continue
      void sub.close().catch(() => {})
      this.browserSubscriptions.delete(id)
      this.browserSubscriptionTabs.delete(id)
    }
  }

  private isBrowserTab(tabId: string): boolean {
    return this.getBrowserPage(tabId) !== null
  }

  private getBrowserPage(tabId: string): BrowserPageHandle | null {
    if (this.tabBackends.get(tabId) === 'browser') {
      return this.browserHost?.getPage(tabId) ?? null
    }
    const page = this.browserHost?.getPage(tabId) ?? null
    if (page) this.tabBackends.set(tabId, 'browser')
    return page
  }

  private async callVisible<T>(name: string, params: unknown): Promise<T> {
    if (this.visibleTabHost) {
      const host = this.visibleTabHost as unknown as Record<string, (params: unknown) => Promise<T>>
      const fn = host[name]
      if (typeof fn !== 'function') {
        throw new Error(`Visible tab host does not support ${name}`)
      }
      return fn.call(this.visibleTabHost, params)
    }

    if (!this.clientInvoker) {
      throw new Error(`NoClientConnected: visible tab operation ${name} requires a connected client`)
    }

    return this.clientInvoker.invokeClientFunction(name, params) as Promise<T>
  }
}

function normalizeTabs(value: unknown): TabData[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeTabOrNull).filter((tab): tab is TabData => tab !== null)
}

function normalizeTabOrNull(value: unknown): TabData | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.tabId === 'string'
    ? raw.tabId
    : (typeof raw.id === 'string' ? raw.id : '')
  if (!id) return null
  const headless = raw.headless === true
  return {
    id,
    tabId: id,
    type: raw.type === 'file' || raw.type === 'url' ? raw.type : 'view',
    title: typeof raw.title === 'string' ? raw.title : '',
    target: typeof raw.target === 'string' ? raw.target : null,
    headless,
    viewport: isViewport(raw.viewport) ? raw.viewport : null,
    viewUpdatedAt: typeof raw.viewUpdatedAt === 'number' ? raw.viewUpdatedAt : null,
    viewChanged: raw.viewChanged === true,
    pinned: raw.pinned === true,
    selected: raw.selected === true,
    params: raw.params && typeof raw.params === 'object' ? raw.params as Record<string, string> : null,
  }
}

function isViewport(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== 'object') return false
  const viewport = value as { width?: unknown; height?: unknown }
  return typeof viewport.width === 'number' && typeof viewport.height === 'number'
}
