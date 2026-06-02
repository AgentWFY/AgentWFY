import type {
  OpenPageResult,
  PageDisplayFilter,
  PageInfo,
} from '#shared/page/types.js'

export interface PagesApi {
  getPages(request?: { display?: PageDisplayFilter }): Promise<PageInfo[]>
  openPage(request: unknown): Promise<OpenPageResult>
  closePage(request: unknown): Promise<void>
  reloadPage(request: unknown): Promise<PageInfo>
  getHeadlessCount(): Promise<number>
}
