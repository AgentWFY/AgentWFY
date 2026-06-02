import type {
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
  PageHostInfo,
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

export class RemoteClientPageHost implements PageHost {
  readonly hostKind = 'remote-client' as const

  private readonly invoker: ClientPageRpcInvoker
  private readonly unsubscribeConnection: (() => void) | undefined
  private readonly pages = new Map<string, PageHostInfo>()
  private currentPageId: string | null = null

  constructor(invoker: ClientPageRpcInvoker) {
    this.invoker = invoker
    this.unsubscribeConnection = invoker.onPageClientConnectionChange?.((connected) => {
      if (connected) {
        void this.refreshSnapshot().catch((err) => {
          console.warn('[remote-client-page-host] snapshot refresh failed:', err)
        })
      } else {
        this.clearClientPages()
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
    const result = await this.invoker.invokeClientPageRpc('client.pages.open', request as ClientPagesOpenRequest)
    const page = this.remember(result.page)
    return new RemoteClientPageHandle(this, this.invoker, page)
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    let page = this.pages.get(pageId) ?? null
    if (!page && this.invoker.isPageClientConnected) {
      await this.refreshSnapshot().catch(() => {
        this.clearClientPages()
      })
      page = this.pages.get(pageId) ?? null
    }
    return page ? new RemoteClientPageHandle(this, this.invoker, page) : null
  }

  async getCurrentClientPage(): Promise<PageHostInfo | null> {
    if (!this.invoker.isPageClientConnected) {
      this.clearClientPages()
      return null
    }
    await this.refreshSnapshot().catch(() => {
      this.clearClientPages()
    })
    if (!this.currentPageId) return null
    return this.pages.get(this.currentPageId) ?? null
  }

  async listPages(): Promise<PageHostInfo[]> {
    if (this.invoker.isPageClientConnected) {
      await this.refreshSnapshot().catch(() => {
        this.clearClientPages()
      })
    } else {
      this.clearClientPages()
    }
    return [...this.pages.values()]
  }

  getKnownPage(pageId: string): PageHostInfo | null {
    return this.pages.get(pageId) ?? null
  }

  remember(page: PageHostInfo): PageHostInfo {
    this.pages.set(page.pageId, page)
    if (page.display === 'foreground') {
      this.currentPageId = page.pageId
    }
    return page
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
    this.currentPageId = snapshot.currentPageId
    this.pages.clear()
    for (const page of snapshot.pages) {
      this.remember(page)
    }
  }

  private clearClientPages(): void {
    this.currentPageId = null
    this.pages.clear()
  }
}

class RemoteClientPageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly host: RemoteClientPageHost,
    private readonly invoker: ClientPageRpcInvoker,
    private page: PageHostInfo,
  ) {
    this.pageId = page.pageId
  }

  info(): PageHostInfo {
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
