import type {
  ClientPageInfo,
  ClientPageRpcMethod,
  ClientPageRpcRequest,
  ClientPageRpcResponse,
  ClientPagesOpenRequest,
  ClientPagesSnapshotResponse,
} from '../backend/protocol.js'
import type { PageHandle } from './page-handle.js'
import type { PageHost, PageHostOpenRequest, PageOpenContext } from './page-host.js'
import type {
  OpenPageRequest,
  PageCdpPollResult,
  PageCdpSubscription,
  PageConsoleLog,
  PageInfo,
  PageInputRequest,
  PageScreenshot,
} from './types.js'

export interface ClientPageRpcInvoker {
  readonly isPageClientConnected: boolean
  invokeClientPageRpc<M extends ClientPageRpcMethod>(
    method: M,
    params: ClientPageRpcRequest<M>,
  ): Promise<ClientPageRpcResponse<M>>
  onPageClientConnectionChange?(handler: (connected: boolean) => void): () => void
}

interface RemoteClientPageHostOptions {
  agentId: string
  clientId?: string
  clientKind?: ClientPageInfo['kind']
}

export class RemoteClientPageHost implements PageHost {
  readonly hostKind = 'remote-client' as const

  private readonly agentId: string
  private readonly invoker: ClientPageRpcInvoker
  private readonly unsubscribeConnection: (() => void) | undefined
  private readonly pages = new Map<string, PageInfo>()
  private client: ClientPageInfo
  private currentPageId: string | null = null

  constructor(invoker: ClientPageRpcInvoker, options: RemoteClientPageHostOptions) {
    this.invoker = invoker
    this.agentId = options.agentId
    this.client = {
      id: options.clientId ?? 'default-client',
      kind: options.clientKind ?? 'desktop',
      activeForAgent: false,
    }
    this.unsubscribeConnection = invoker.onPageClientConnectionChange?.((connected) => {
      if (connected) {
        void this.refreshSnapshot().catch((err) => {
          console.warn('[remote-client-page-host] snapshot refresh failed:', err)
        })
      } else {
        this.markUnavailable()
      }
    })
  }

  dispose(): void {
    this.unsubscribeConnection?.()
  }

  canOpen(request: OpenPageRequest, _context: PageOpenContext): boolean {
    return request.display === 'foreground' || request.display === 'background'
  }

  async openPage(request: PageHostOpenRequest): Promise<PageHandle> {
    const { owner: _owner, ...openRequest } = request
    const result = await this.invoker.invokeClientPageRpc('client.pages.open', openRequest as ClientPagesOpenRequest)
    const page = this.remember(result.page)
    return new RemoteClientPageHandle(this, this.invoker, page)
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    let page = this.pages.get(pageId) ?? null
    if (!page && this.invoker.isPageClientConnected) {
      await this.refreshSnapshot().catch(() => {
        this.markUnavailable()
      })
      page = this.pages.get(pageId) ?? null
    }
    return page ? new RemoteClientPageHandle(this, this.invoker, page) : null
  }

  async getCurrentClientPage(): Promise<PageInfo | null> {
    if (!this.invoker.isPageClientConnected) {
      this.markUnavailable()
      return null
    }
    await this.refreshSnapshot().catch(() => {
      this.markUnavailable()
    })
    if (!this.currentPageId) return null
    return this.pages.get(this.currentPageId) ?? null
  }

  async listPages(): Promise<PageInfo[]> {
    if (this.invoker.isPageClientConnected) {
      await this.refreshSnapshot().catch(() => {
        this.markUnavailable()
      })
    } else {
      this.markUnavailable()
    }
    return [...this.pages.values()]
  }

  getKnownPage(pageId: string): PageInfo | null {
    return this.pages.get(pageId) ?? null
  }

  remember(page: PageInfo): PageInfo {
    const normalized = this.decorateClientPage(page, this.invoker.isPageClientConnected)
    this.pages.set(normalized.pageId, normalized)
    if (normalized.display === 'foreground') {
      this.currentPageId = normalized.pageId
    }
    return normalized
  }

  forget(pageId: string): void {
    this.pages.delete(pageId)
    if (this.currentPageId === pageId) this.currentPageId = null
  }

  private async refreshSnapshot(): Promise<void> {
    const snapshot = await this.invoker.invokeClientPageRpc('client.pages.snapshot', {})
    this.applySnapshot(snapshot)
  }

  private applySnapshot(snapshot: ClientPagesSnapshotResponse): void {
    this.client = snapshot.client
    this.currentPageId = snapshot.currentPageId
    this.pages.clear()
    for (const page of snapshot.pages) {
      this.remember(page)
    }
  }

  private markUnavailable(): void {
    this.client = {
      ...this.client,
      activeForAgent: false,
    }
    this.currentPageId = null
    for (const [pageId, page] of this.pages) {
      this.pages.set(pageId, this.decorateClientPage({
        ...page,
        lifecycle: 'unavailable',
      }, false))
    }
  }

  private decorateClientPage(page: PageInfo, connected: boolean): PageInfo {
    const presentation = page.presentation
    const isUserFacing = page.display !== 'headless'
    const activeForAgent = connected && this.client.activeForAgent
    const visibilityReason = !connected
      ? 'suspended'
      : activeForAgent
        ? presentation?.visibilityReason
        : 'inactive-agent'

    return {
      ...page,
      lifecycle: connected ? page.lifecycle : 'unavailable',
      owner: {
        agentId: this.agentId,
        hostKind: this.hostKind,
        client: this.client,
      },
      ...(isUserFacing
        ? {
            presentation: {
              surfaceId: presentation?.surfaceId ?? `${this.client.id}:pages`,
              visibleNow: activeForAgent ? presentation?.visibleNow === true : false,
              ...(visibilityReason ? { visibilityReason } : {}),
            },
          }
        : {}),
    }
  }
}

class RemoteClientPageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly host: RemoteClientPageHost,
    private readonly invoker: ClientPageRpcInvoker,
    private page: PageInfo,
  ) {
    this.pageId = page.pageId
  }

  info(): PageInfo {
    return this.host.getKnownPage(this.pageId) ?? this.page
  }

  async close(): Promise<void> {
    await this.invoker.invokeClientPageRpc('client.pages.close', { pageId: this.pageId })
    this.host.forget(this.pageId)
  }

  async reload(): Promise<void> {
    const page = await this.invoker.invokeClientPageRpc('client.pages.reload', { pageId: this.pageId })
    this.page = this.host.remember(page)
  }

  async capture(): Promise<PageScreenshot> {
    return this.invoker.invokeClientPageRpc('client.pages.capture', { pageId: this.pageId })
  }

  async runJs(code: string, timeoutMs?: number): Promise<unknown> {
    return this.invoker.invokeClientPageRpc('client.pages.runJs', {
      pageId: this.pageId,
      code,
      timeoutMs,
    })
  }

  async sendInput(input: PageInputRequest): Promise<void> {
    await this.invoker.invokeClientPageRpc('client.pages.sendInput', input)
  }

  async inspectElement(selector: string): Promise<unknown> {
    return this.invoker.invokeClientPageRpc('client.pages.inspectElement', {
      pageId: this.pageId,
      selector,
    })
  }

  async getConsoleLogs(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]> {
    return this.invoker.invokeClientPageRpc('client.pages.getConsoleLogs', {
      pageId: this.pageId,
      since: request?.since,
      limit: request?.limit,
    })
  }

  async sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    return this.invoker.invokeClientPageRpc('client.pages.sendCdp', {
      pageId: this.pageId,
      method,
      params,
      sessionId,
    })
  }

  async subscribeCdp(events: string[]): Promise<PageCdpSubscription> {
    const { subscriptionId } = await this.invoker.invokeClientPageRpc('client.pages.subscribeCdp', {
      pageId: this.pageId,
      events,
    })
    return {
      poll: (request?: { maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult> => {
        return this.invoker.invokeClientPageRpc('client.pages.pollCdp', {
          subscriptionId,
          maxBatch: request?.maxBatch,
          maxWaitMs: request?.maxWaitMs,
        })
      },
      close: async (): Promise<void> => {
        await this.invoker.invokeClientPageRpc('client.pages.unsubscribeCdp', { subscriptionId })
      },
    }
  }

  async detachCdp(): Promise<void> {
    await this.invoker.invokeClientPageRpc('client.pages.detachCdp', { pageId: this.pageId })
  }
}
