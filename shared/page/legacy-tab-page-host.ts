import type {
  HeadlessCloseAfterIdleMs,
  TabApi,
  TabData,
  TabSendInputRequest,
  ViewportInput,
} from '../runtime/hosts.js'
import type { PageHandle } from './page-handle.js'
import type { PageHost, PageHostOpenRequest, PageOpenContext } from './page-host.js'
import type {
  OpenPageRequest,
  PageCdpSubscription,
  PageCloseAfterIdleMs,
  PageConsoleLog,
  PageDisplay,
  PageInfo,
  PageInputRequest,
  PageOwnerHostKind,
  PageScreenshot,
  PageSource,
  PageViewportInput,
} from './types.js'
import { pageCapabilitiesFromHandleMethods } from './capabilities.js'
import { pageSourceParams, pageSourceToLegacyTabOpenSource } from './page-source.js'

interface LegacyTabPageHostOptions {
  agentId: string
  hostKind?: PageOwnerHostKind
  headlessHostKind?: PageOwnerHostKind
  displays?: PageDisplay[]
}

export class LegacyTabPageHost implements PageHost {
  readonly hostKind: PageOwnerHostKind
  private readonly tabTools: TabApi
  private readonly agentId: string
  private readonly headlessHostKind: PageOwnerHostKind
  private readonly displays: ReadonlySet<PageDisplay>
  private readonly pages = new Map<string, TabData>()

  constructor(tabTools: TabApi, options: LegacyTabPageHostOptions) {
    this.tabTools = tabTools
    this.agentId = options.agentId
    this.hostKind = options.hostKind ?? 'desktop'
    this.headlessHostKind = options.headlessHostKind ?? 'desktop-headless'
    this.displays = new Set(options.displays ?? ['foreground', 'headless'])
  }

  canOpen(request: OpenPageRequest, _context: PageOpenContext): boolean {
    return this.displays.has(request.display)
  }

  async openPage(request: PageHostOpenRequest): Promise<PageHandle> {
    if (request.display === 'background') {
      throw new Error('Background page open is not supported by the legacy tab adapter')
    }

    const result = await this.tabTools.openTab({
      ...pageSourceToLegacyTabOpenSource(request.source),
      title: request.title,
      headless: request.display === 'headless',
      viewport: toLegacyViewport(request.viewport),
      width: request.width,
      height: request.height,
      closeAfterIdleMs: toLegacyCloseAfterIdleMs(request.closeAfterIdleMs),
      params: pageSourceParams(request.source),
    })
    const tab = await this.getTab(result.tabId)
    if (!tab) throw new Error(`Failed to create page "${result.tabId}"`)
    return new LegacyTabPageHandle(this.tabTools, this, tab)
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    const tab = await this.getTab(pageId)
    return tab ? new LegacyTabPageHandle(this.tabTools, this, tab) : null
  }

  async getCurrentPage(): Promise<PageInfo | null> {
    const tab = await this.tabTools.getCurrentTab()
    if (!tab) return null
    this.pages.set(tab.tabId || tab.id, tab)
    return this.pageInfoFromTab(tab)
  }

  async listPages(): Promise<PageInfo[]> {
    const tabs = await this.tabTools.getTabs()
    for (const tab of tabs) {
      this.pages.set(tab.tabId || tab.id, tab)
    }
    return tabs.map(tab => this.pageInfoFromTab(tab))
  }

  pageInfoFromTab(tab: TabData): PageInfo {
    const pageId = tab.tabId || tab.id
    const display = displayFromTab(tab)
    return {
      pageId,
      title: tab.title || '',
      source: sourceFromTab(tab),
      ...(tab.type === 'url' && tab.target ? { currentUrl: tab.target } : {}),
      display,
      lifecycle: 'ready',
      capabilities: pageCapabilitiesFromHandleMethods(LegacyTabPageHandle.prototype),
      ...(tab.viewport ? { viewport: tab.viewport } : {}),
      owner: {
        agentId: this.agentId,
        hostKind: tab.headless ? this.headlessHostKind : this.hostKind,
      },
      ...(display !== 'headless'
        ? {
            presentation: {
              surfaceId: 'desktop-tabs',
              visibleNow: tab.selected,
              ...(tab.selected ? { visibilityReason: 'visible' as const } : {}),
            },
          }
        : {}),
      createdBy: 'agent',
      content: {
        stale: tab.viewChanged,
        ...(typeof tab.viewUpdatedAt === 'number' ? { version: tab.viewUpdatedAt } : {}),
      },
      openedAt: tab.openedAt ?? 0,
      ...(typeof tab.lastUsedAt === 'number' ? { lastUsedAt: tab.lastUsedAt } : {}),
      ...(tab.closeAfterIdleMs ? { closeAfterIdleMs: tab.closeAfterIdleMs } : {}),
      ...(typeof tab.expiresAt === 'number' ? { expiresAt: tab.expiresAt } : {}),
    }
  }

  private async getTab(pageId: string): Promise<TabData | null> {
    const cached = this.pages.get(pageId)
    if (cached) return cached
    const tabs = await this.tabTools.getTabs()
    for (const tab of tabs) {
      const id = tab.tabId || tab.id
      this.pages.set(id, tab)
      if (id === pageId) return tab
    }
    return null
  }
}

class LegacyTabPageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly tabTools: TabApi,
    private readonly host: LegacyTabPageHost,
    private tab: TabData,
  ) {
    this.pageId = tab.tabId || tab.id
  }

  info(): PageInfo {
    return this.host.pageInfoFromTab(this.tab)
  }

  async show(): Promise<void> {
    await this.tabTools.selectTab({ tabId: this.pageId })
    await this.refresh()
  }

  async close(): Promise<void> {
    await this.tabTools.closeTab({ tabId: this.pageId })
  }

  async reload(): Promise<void> {
    await this.tabTools.reloadTab({ tabId: this.pageId })
    await this.refresh()
  }

  async capture(): Promise<PageScreenshot> {
    const result = await this.tabTools.captureTab({ tabId: this.pageId })
    await this.refresh()
    return {
      ...result,
      pageId: this.pageId,
      capturedPageId: this.pageId,
    }
  }

  async runJs(code: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.tabTools.execTabJs({ tabId: this.pageId, code, timeoutMs })
    await this.refresh()
    return result
  }

  async sendInput(input: PageInputRequest): Promise<void> {
    await this.tabTools.sendInput(toLegacyInput(input))
    await this.refresh()
  }

  async inspectElement(selector: string): Promise<unknown> {
    const result = await this.tabTools.inspectElement({ tabId: this.pageId, selector })
    await this.refresh()
    return result
  }

  async getConsoleLogs(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]> {
    await this.refresh()
    return this.tabTools.getTabConsoleLogs({
      tabId: this.pageId,
      since: request?.since,
      limit: request?.limit,
    })
  }

  async sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const result = await this.tabTools.tabDebuggerSend({
      tabId: this.pageId,
      method,
      params,
      sessionId,
    })
    await this.refresh()
    return result
  }

  async subscribeCdp(events: string[]): Promise<PageCdpSubscription> {
    const subscriptionId = `legacy-page-${this.pageId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await this.tabTools.tabDebuggerSubscribe({
      tabId: this.pageId,
      subscriptionId,
      events,
    })
    return {
      poll: request => this.tabTools.tabDebuggerPoll({
        subscriptionId,
        maxBatch: request?.maxBatch,
        maxWaitMs: request?.maxWaitMs,
      }),
      close: async () => {
        await this.tabTools.tabDebuggerUnsubscribe({ subscriptionId })
      },
    }
  }

  async detachCdp(): Promise<void> {
    await this.tabTools.tabDebuggerDetach({ tabId: this.pageId })
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    const handle = await this.host.getPage(this.pageId)
    if (handle instanceof LegacyTabPageHandle) {
      this.tab = handle.tab
    }
  }
}

function displayFromTab(tab: TabData): PageDisplay {
  if (tab.headless) return 'headless'
  return tab.selected ? 'foreground' : 'background'
}

function sourceFromTab(tab: TabData): PageSource {
  const target = tab.target ?? ''
  if (tab.type === 'url') return { type: 'url', url: target }
  if (tab.type === 'file') {
    return {
      type: 'file',
      path: target,
      ...(tab.params ? { params: tab.params } : {}),
    }
  }
  return {
    type: 'view',
    name: target,
    ...(tab.params ? { params: tab.params } : {}),
  }
}

function toLegacyViewport(input: PageViewportInput | undefined): ViewportInput | undefined {
  if (!input) return undefined
  return input
}

function toLegacyCloseAfterIdleMs(input: PageCloseAfterIdleMs | undefined): HeadlessCloseAfterIdleMs | undefined {
  return input
}

function toLegacyInput(input: PageInputRequest): TabSendInputRequest {
  return {
    tabId: input.pageId,
    type: input.type,
    x: input.x,
    y: input.y,
    button: input.button,
    clickCount: input.clickCount,
    deltaX: input.deltaX,
    deltaY: input.deltaY,
    keyCode: input.keyCode,
    modifiers: input.modifiers,
  }
}
