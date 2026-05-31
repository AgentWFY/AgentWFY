import type {
  OpenPageResult,
  PageDisplayFilter,
  PageInfo,
} from '#shared/page/types.js'

export interface PagesApi {
  getPages(request?: { display?: PageDisplayFilter; clientId?: string }): Promise<PageInfo[]>
  getCurrentPage(request?: { clientId?: string }): Promise<PageInfo | null>
  openPage(request: unknown): Promise<OpenPageResult>
  showPage(request: unknown): Promise<PageInfo>
  closePage(request: unknown): Promise<void>
  reloadPage(request: unknown): Promise<PageInfo>
  getHeadlessCount(): Promise<number>
}
