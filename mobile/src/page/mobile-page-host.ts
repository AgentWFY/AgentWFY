import { PageManager } from '#shared/page/page-manager.js'
import type { PageHandle } from '#shared/page/page-handle.js'
import type { PageHost, PageHostOpenRequest, PageOpenContext } from '#shared/page/page-host.js'
import type {
  OpenPageRequest,
  PageApi,
  PageHostInfo,
  PageSource,
} from '#shared/page/types.js'

interface MobilePageRecord {
  pageId: string
  title: string
  source: Extract<PageSource, { type: 'view' }>
  version: number
}

type CurrentPageSubscriber = (page: PageHostInfo | null) => void

export class MobilePageController {
  readonly host: MobilePageHost
  readonly pageTools: PageApi

  constructor(agentId: string) {
    this.host = new MobilePageHost()
    this.pageTools = new PageManager({
      agentId,
      hosts: [this.host],
    })
  }

  getCurrentClientPage(): PageHostInfo | null {
    return this.host.getCurrentClientPageSync()
  }

  subscribeCurrentPage(handler: CurrentPageSubscriber): () => void {
    return this.host.subscribeCurrentPage(handler)
  }

  renameCurrentView(name: string): PageHostInfo | null {
    return this.host.renameCurrentView(name)
  }

  dispose(): void {
    this.host.dispose()
  }
}

export class MobilePageHost implements PageHost {
  readonly hostKind = 'mobile' as const

  private readonly pages = new Map<string, MobilePageRecord>()
  private readonly currentPageSubscribers = new Set<CurrentPageSubscriber>()
  private currentPageId: string | null = null
  private nextContentVersion = 1

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

    const record: MobilePageRecord = {
      pageId: request.pageId,
      title: request.title || request.source.name,
      source: request.source,
      version: this.nextContentVersion++,
    }

    this.pages.clear()
    this.pages.set(record.pageId, record)
    this.currentPageId = record.pageId

    this.emitCurrentPage()

    return new IframePageHandle(this, record.pageId)
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    return this.pages.has(pageId) ? new IframePageHandle(this, pageId) : null
  }

  async getCurrentClientPage(): Promise<PageHostInfo | null> {
    return this.getCurrentClientPageSync()
  }

  getCurrentClientPageSync(): PageHostInfo | null {
    const record = this.currentPageId ? this.pages.get(this.currentPageId) : null
    return record ? this.pageInfoFromRecord(record) : null
  }

  async listPages(): Promise<PageHostInfo[]> {
    return [...this.pages.values()].map(record => this.pageInfoFromRecord(record))
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
    if (wasCurrent) {
      this.emitCurrentPage()
    }
  }

  async reloadPage(pageId: string): Promise<void> {
    const record = this.requireRecord(pageId)
    record.version = this.nextContentVersion++
    this.emitCurrentPage()
  }

  renameCurrentView(name: string): PageHostInfo | null {
    const record = this.currentPageId ? this.pages.get(this.currentPageId) : null
    if (!record) return null
    const previousName = record.source.name
    record.source = {
      ...record.source,
      name,
    }
    if (!record.title || record.title === previousName) record.title = name
    record.version = this.nextContentVersion++
    const page = this.pageInfoFromRecord(record)
    this.emitCurrentPage()
    return page
  }

  pageInfo(pageId: string): PageHostInfo {
    return this.pageInfoFromRecord(this.requireRecord(pageId))
  }

  dispose(): void {
    this.pages.clear()
    this.currentPageId = null
    this.emitCurrentPage()
    this.currentPageSubscribers.clear()
  }

  private pageInfoFromRecord(record: MobilePageRecord): PageHostInfo {
    return {
      pageId: record.pageId,
      title: record.title,
      source: record.source,
      display: 'foreground',
      version: record.version,
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
}

export class IframePageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly host: MobilePageHost,
    pageId: string,
  ) {
    this.pageId = pageId
  }

  info(): PageHostInfo {
    return this.host.pageInfo(this.pageId)
  }

  async close(): Promise<void> {
    await this.host.closePage(this.pageId)
  }

  async reload(): Promise<void> {
    await this.host.reloadPage(this.pageId)
  }
}
