import { PageManager } from '#shared/page/page-manager.js'
import type { PageHandle } from '#shared/page/page-handle.js'
import type { PageHost, PageHostOpenRequest, PageOpenContext } from '#shared/page/page-host.js'
import type {
  OpenPageRequest,
  PageApi,
  PageEvent,
  PageInfo,
  PageOwner,
  PageSource,
} from '#shared/page/types.js'

interface MobilePageRecord {
  pageId: string
  title: string
  source: Extract<PageSource, { type: 'view' }>
  owner: PageOwner
  createdBy: PageInfo['createdBy']
  openedAt: number
  lastUsedAt: number
  version: number
}

type CurrentPageSubscriber = (page: PageInfo | null) => void
type PageEventSubscriber = (event: PageEvent) => void

export class MobilePageController {
  readonly host: MobilePageHost
  readonly pageTools: PageApi

  constructor(agentId: string) {
    this.host = new MobilePageHost({ agentId })
    this.pageTools = new PageManager({
      agentId,
      hosts: [this.host],
    })
  }

  getCurrentClientPage(): PageInfo | null {
    return this.host.getCurrentClientPageSync()
  }

  subscribeCurrentPage(handler: CurrentPageSubscriber): () => void {
    return this.host.subscribeCurrentPage(handler)
  }

  renameCurrentView(name: string): PageInfo | null {
    return this.host.renameCurrentView(name)
  }

  dispose(): void {
    this.host.dispose()
  }
}

export class MobilePageHost implements PageHost {
  readonly hostKind = 'mobile' as const

  private readonly agentId: string
  private readonly pages = new Map<string, MobilePageRecord>()
  private readonly currentPageSubscribers = new Set<CurrentPageSubscriber>()
  private readonly pageEventSubscribers = new Set<PageEventSubscriber>()
  private currentPageId: string | null = null
  private nextContentVersion = 1
  private nextEventVersion = 1

  constructor(options: { agentId: string }) {
    this.agentId = options.agentId
  }

  canOpen(request: OpenPageRequest, _context: PageOpenContext): boolean {
    return request.source.type === 'view'
      && (request.display === 'foreground' || request.display === 'background')
  }

  async openPage(request: PageHostOpenRequest): Promise<PageHandle> {
    if (request.source.type !== 'view') {
      throw new Error('Mobile pages currently support view sources only')
    }
    if (request.display === 'background') {
      throw new Error('Mobile background pages are not implemented yet')
    }
    if (request.display !== 'foreground') {
      throw new Error(`Mobile pages do not support display "${request.display}"`)
    }

    const now = Date.now()
    const previousPageIds = [...this.pages.keys()]
    const record: MobilePageRecord = {
      pageId: request.pageId,
      title: request.title || request.source.name,
      source: request.source,
      owner: request.owner,
      createdBy: request.createdBy ?? 'agent',
      openedAt: now,
      lastUsedAt: now,
      version: this.nextContentVersion++,
    }

    this.pages.clear()
    this.pages.set(record.pageId, record)
    this.currentPageId = record.pageId

    for (const pageId of previousPageIds) {
      this.emitPageEvent('page.closed', pageId)
    }
    const page = this.pageInfoFromRecord(record)
    this.emitPageEvent('page.created', record.pageId, page)
    this.emitPageEvent('page.currentChanged', record.pageId, page, {
      previousPageId: previousPageIds[0] ?? null,
      currentPageId: record.pageId,
    })
    this.emitCurrentPage()

    return new IframePageHandle(this, record.pageId)
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    return this.pages.has(pageId) ? new IframePageHandle(this, pageId) : null
  }

  async getCurrentClientPage(): Promise<PageInfo | null> {
    return this.getCurrentClientPageSync()
  }

  getCurrentClientPageSync(): PageInfo | null {
    const record = this.currentPageId ? this.pages.get(this.currentPageId) : null
    return record ? this.pageInfoFromRecord(record) : null
  }

  async listPages(): Promise<PageInfo[]> {
    return [...this.pages.values()].map(record => this.pageInfoFromRecord(record))
  }

  onPageEvent(handler: PageEventSubscriber): () => void {
    this.pageEventSubscribers.add(handler)
    return () => {
      this.pageEventSubscribers.delete(handler)
    }
  }

  subscribeCurrentPage(handler: CurrentPageSubscriber): () => void {
    this.currentPageSubscribers.add(handler)
    handler(this.getCurrentClientPageSync())
    return () => {
      this.currentPageSubscribers.delete(handler)
    }
  }

  async closePage(pageId: string): Promise<void> {
    if (!this.pages.has(pageId)) return
    this.pages.delete(pageId)
    const wasCurrent = this.currentPageId === pageId
    if (wasCurrent) this.currentPageId = null
    this.emitPageEvent('page.closed', pageId)
    if (wasCurrent) {
      this.emitPageEvent('page.currentChanged', pageId, undefined, {
        previousPageId: pageId,
        currentPageId: null,
      })
      this.emitCurrentPage()
    }
  }

  async reloadPage(pageId: string): Promise<void> {
    const record = this.requireRecord(pageId)
    record.lastUsedAt = Date.now()
    record.version = this.nextContentVersion++
    const page = this.pageInfoFromRecord(record)
    this.emitPageEvent('page.updated', pageId, page)
    this.emitCurrentPage()
  }

  renameCurrentView(name: string): PageInfo | null {
    const record = this.currentPageId ? this.pages.get(this.currentPageId) : null
    if (!record) return null
    const previousName = record.source.name
    record.source = {
      ...record.source,
      name,
    }
    if (!record.title || record.title === previousName) record.title = name
    record.lastUsedAt = Date.now()
    record.version = this.nextContentVersion++
    const page = this.pageInfoFromRecord(record)
    this.emitPageEvent('page.updated', record.pageId, page)
    this.emitCurrentPage()
    return page
  }

  pageInfo(pageId: string): PageInfo {
    return this.pageInfoFromRecord(this.requireRecord(pageId))
  }

  dispose(): void {
    const pageIds = [...this.pages.keys()]
    this.pages.clear()
    this.currentPageId = null
    for (const pageId of pageIds) {
      this.emitPageEvent('page.closed', pageId)
    }
    this.emitCurrentPage()
    this.currentPageSubscribers.clear()
    this.pageEventSubscribers.clear()
  }

  private pageInfoFromRecord(record: MobilePageRecord): PageInfo {
    return {
      pageId: record.pageId,
      title: record.title,
      source: record.source,
      display: 'foreground',
      lifecycle: 'ready',
      owner: {
        ...record.owner,
        agentId: this.agentId,
        hostKind: this.hostKind,
      },
      presentation: {
        surfaceId: 'mobile-view',
        visibleNow: this.currentPageId === record.pageId,
        visibilityReason: this.currentPageId === record.pageId ? 'visible' : 'suspended',
      },
      createdBy: record.createdBy,
      content: {
        stale: false,
        version: record.version,
      },
      openedAt: record.openedAt,
      lastUsedAt: record.lastUsedAt,
    }
  }

  private requireRecord(pageId: string): MobilePageRecord {
    const record = this.pages.get(pageId)
    if (!record) throw new Error(`Page not found: ${pageId}`)
    return record
  }

  private emitCurrentPage(): void {
    const page = this.getCurrentClientPageSync()
    for (const handler of this.currentPageSubscribers) {
      try {
        handler(page)
      } catch (err) {
        console.warn('[mobile-page-host] current page subscriber failed:', err)
      }
    }
  }

  private emitPageEvent(
    type: PageEvent['type'],
    pageId: string,
    page?: PageInfo,
    extra: Partial<Pick<PageEvent, 'previousPageId' | 'currentPageId'>> = {},
  ): void {
    const event: PageEvent = {
      type,
      pageId,
      version: this.nextEventVersion++,
      timestamp: Date.now(),
      ...(page ? { page } : {}),
      ...extra,
    }
    for (const handler of this.pageEventSubscribers) {
      try {
        handler(event)
      } catch (err) {
        console.warn('[mobile-page-host] page event subscriber failed:', err)
      }
    }
  }
}

export class IframePageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly host: MobilePageHost,
    pageId: string,
  ) {
    this.pageId = pageId
  }

  info(): PageInfo {
    return this.host.pageInfo(this.pageId)
  }

  async close(): Promise<void> {
    await this.host.closePage(this.pageId)
  }

  async reload(): Promise<void> {
    await this.host.reloadPage(this.pageId)
  }
}
