import type { PageHandle } from './page-handle.js'
import type { PageHost } from './page-host.js'
import type {
  CapturePageRequest,
  OpenPageRequest,
  OpenPageResult,
  PageApi,
  PageCdpPollResult,
  PageCdpSubscription,
  PageDisplay,
  PageInfo,
  PageInputRequest,
  PageQueryRequest,
  PageScreenshot,
} from './types.js'
import { formatPageSource } from './page-source.js'

interface PageManagerOptions {
  agentId: string
  hosts: PageHost[]
}

interface TrackedSubscription {
  pageId: string
  subscription: PageCdpSubscription
}

export class PageManager implements PageApi {
  private readonly agentId: string
  private readonly hosts: PageHost[]
  private readonly pageHosts = new Map<string, PageHost>()
  private readonly subscriptions = new Map<string, TrackedSubscription>()

  constructor(options: PageManagerOptions) {
    this.agentId = options.agentId
    this.hosts = options.hosts
  }

  async getPages(request: PageQueryRequest = {}): Promise<PageInfo[]> {
    const pages: PageInfo[] = []
    for (const host of this.hosts) {
      const hostPages = await host.listPages?.() ?? []
      for (const page of hostPages) {
        pages.push(page)
        this.pageHosts.set(page.pageId, host)
      }
    }

    return pages.filter((page) => pageMatchesQuery(page, request))
  }

  async getCurrentClientPage(): Promise<PageInfo | null> {
    for (const host of this.hosts) {
      const page = await host.getCurrentClientPage?.() ?? null
      if (page) {
        this.pageHosts.set(page.pageId, host)
        return page
      }
    }
    return null
  }

  async openPage(request: OpenPageRequest): Promise<OpenPageResult> {
    validateOpenPageRequest(request)
    const context = { agentId: this.agentId }
    const host = this.hosts.find(candidate => candidate.canOpen(request, context))
    if (!host) {
      throw new Error(`No page host is available for display "${request.display}" and source type "${request.source.type}"`)
    }

    const requestedPageId = request.pageId?.trim() || randomId('page')
    if (this.pageHosts.has(requestedPageId)) {
      throw new Error(`Page ID is already in use: ${requestedPageId}`)
    }
    const handle = await host.openPage({
      ...request,
      pageId: requestedPageId,
      owner: {
        agentId: this.agentId,
        hostKind: host.hostKind,
      },
      createdBy: request.createdBy ?? 'agent',
    })
    this.pageHosts.set(handle.pageId, host)
    const page = handle.info()
    return {
      pageId: page.pageId,
      page,
      info: formatOpenPageInfo(page),
    }
  }

  async closePage(request: { pageId: string }): Promise<void> {
    const handle = await this.resolveHandle(request.pageId)
    this.closeSubscriptionsForPage(request.pageId)
    await handle.close()
    this.pageHosts.delete(request.pageId)
  }

  async reloadPage(request: { pageId: string }): Promise<PageInfo> {
    const handle = await this.resolveHandle(request.pageId)
    await handle.reload()
    return handle.info()
  }

  async capturePage(request: CapturePageRequest): Promise<PageScreenshot> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.capture) {
      throw new Error(`Page host does not implement capturePage for "${request.pageId}"`)
    }
    return handle.capture()
  }

  async runPageJs(request: { pageId: string; code: string; timeoutMs?: number }): Promise<unknown> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.runJs) {
      throw new Error(`Page host does not implement runPageJs for "${request.pageId}"`)
    }
    return handle.runJs(request.code, request.timeoutMs)
  }

  async sendPageInput(request: PageInputRequest): Promise<void> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.sendInput) {
      throw new Error(`Page host does not implement sendPageInput for "${request.pageId}"`)
    }
    await handle.sendInput(request)
  }

  async inspectPageElement(request: { pageId: string; selector: string }): Promise<unknown> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.inspectElement) {
      throw new Error(`Page host does not implement inspectPageElement for "${request.pageId}"`)
    }
    return handle.inspectElement(request.selector)
  }

  async getPageConsoleLogs(request: { pageId: string; since?: number; limit?: number }) {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.getConsoleLogs) {
      throw new Error(`Page host does not implement getPageConsoleLogs for "${request.pageId}"`)
    }
    return handle.getConsoleLogs({
      since: request.since,
      limit: request.limit,
    })
  }

  async sendPageCdp(request: { pageId: string; method: string; params?: unknown; sessionId?: string }): Promise<unknown> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.sendCdp) {
      throw new Error(`Page host does not implement sendPageCdp for "${request.pageId}"`)
    }
    return handle.sendCdp(request.method, request.params, request.sessionId)
  }

  async subscribePageCdp(request: { pageId: string; events: string[] }): Promise<{ subscriptionId: string }> {
    const handle = await this.resolveHandle(request.pageId)
    if (!handle.subscribeCdp) {
      throw new Error(`Page host does not implement subscribePageCdp for "${request.pageId}"`)
    }
    const subscriptionId = `pagecdp-${randomHex(8)}`
    this.subscriptions.set(subscriptionId, {
      pageId: request.pageId,
      subscription: await handle.subscribeCdp(request.events),
    })
    return { subscriptionId }
  }

  async pollPageCdp(request: { subscriptionId: string; maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult> {
    const tracked = this.subscriptions.get(request.subscriptionId)
    if (!tracked) {
      return { events: [], dropped: 0, closed: true }
    }
    const result = await tracked.subscription.poll({
      maxBatch: request.maxBatch,
      maxWaitMs: request.maxWaitMs,
    })
    if (result.closed) this.subscriptions.delete(request.subscriptionId)
    return result
  }

  async unsubscribePageCdp(request: { subscriptionId: string }): Promise<void> {
    const tracked = this.subscriptions.get(request.subscriptionId)
    if (!tracked) return
    this.subscriptions.delete(request.subscriptionId)
    await tracked.subscription.close()
  }

  async detachPageCdp(request: { pageId: string }): Promise<void> {
    const handle = await this.resolveHandle(request.pageId)
    this.closeSubscriptionsForPage(request.pageId)
    await handle.detachCdp?.()
  }

  private async resolveHandle(pageId: string): Promise<PageHandle> {
    const knownHost = this.pageHosts.get(pageId)
    if (knownHost) {
      const handle = await knownHost.getPage(pageId)
      if (handle) return handle
      this.pageHosts.delete(pageId)
    }

    for (const host of this.hosts) {
      const handle = await host.getPage(pageId)
      if (handle) {
        this.pageHosts.set(pageId, host)
        return handle
      }
    }

    throw new Error(`Page not found: ${pageId}`)
  }

  private closeSubscriptionsForPage(pageId: string): void {
    for (const [subscriptionId, tracked] of this.subscriptions) {
      if (tracked.pageId !== pageId) continue
      void tracked.subscription.close().catch(() => {})
      this.subscriptions.delete(subscriptionId)
    }
  }
}

function validateOpenPageRequest(request: OpenPageRequest): void {
  if (!request || typeof request !== 'object') {
    throw new Error('openPage requires a request object')
  }
  if (!isPageDisplay(request.display)) {
    throw new Error('openPage requires explicit display: "foreground", "background", or "headless"')
  }
  if (!request.source || typeof request.source !== 'object') {
    throw new Error('openPage requires a source object')
  }
  if (request.pageId !== undefined && (typeof request.pageId !== 'string' || request.pageId.trim().length === 0)) {
    throw new Error('openPage pageId must be a non-empty string when provided')
  }
}

function isPageDisplay(value: unknown): value is PageDisplay {
  return value === 'foreground' || value === 'background' || value === 'headless'
}

function pageMatchesQuery(page: PageInfo, request: PageQueryRequest): boolean {
  const display = request.display ?? 'all'
  if (display === 'all') return true
  if (display === 'user-facing') return page.display !== 'headless'
  return page.display === display
}

function formatOpenPageInfo(page: PageInfo): string {
  const source = formatPageSource(page.source)
  if (page.display === 'headless') {
    const viewport = page.viewport ? ` (${page.viewport.width}x${page.viewport.height})` : ''
    if (page.closeAfterIdleMs === 'never') {
      return `Opened headless page ${page.pageId} for ${source}${viewport}. It stays open until closePage is called.`
    }
    return `Opened headless page ${page.pageId} for ${source}${viewport}.`
  }
  return `Opened ${page.display} page ${page.pageId} for ${source}.`
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`
  }
  return `${prefix}-${randomHex(16)}`
}

function randomHex(byteCount: number): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = new Uint8Array(byteCount)
    cryptoApi.getRandomValues(bytes)
    return bytesToHex(bytes)
  }

  let out = ''
  for (let i = 0; i < byteCount; i++) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}
