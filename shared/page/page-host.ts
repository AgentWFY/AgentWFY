import type { PageHostInfo, OpenPageRequest, PageHostKind } from './types.js'
import type { PageHandle } from './page-handle.js'

export interface PageOpenContext {
  agentId: string
}

export type PageHostOpenRequest = OpenPageRequest & {
  pageId: string
}

export interface PageHost {
  readonly hostKind: PageHostKind
  canOpen(request: OpenPageRequest, context: PageOpenContext): boolean
  openPage(request: PageHostOpenRequest): Promise<PageHandle>
  getPage(pageId: string): Promise<PageHandle | null>
  getCurrentClientPage?(): Promise<PageHostInfo | null>
  listPages?(): Promise<PageHostInfo[]>
}
