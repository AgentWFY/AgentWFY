import type { PageEvent, PageInfo, PageOwner, OpenPageRequest } from './types.js'
import type { PageHandle } from './page-handle.js'

export interface PageOpenContext {
  agentId: string
  clientId?: string
}

export type PageHostOpenRequest = OpenPageRequest & {
  pageId: string
  owner: PageOwner
}

export interface PageHost {
  readonly hostKind: PageInfo['owner']['hostKind']
  canOpen(request: OpenPageRequest, context: PageOpenContext): boolean
  openPage(request: PageHostOpenRequest): Promise<PageHandle>
  getPage(pageId: string): Promise<PageHandle | null>
  getCurrentPage?(request?: { clientId?: string }): Promise<PageInfo | null>
  listPages?(): Promise<PageInfo[]>
  onPageEvent?(handler: (event: PageEvent) => void): () => void
}
