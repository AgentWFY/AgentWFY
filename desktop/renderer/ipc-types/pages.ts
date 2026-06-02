import type {
  OpenPageResult,
  PageDisplayFilter,
  PageHostInfo,
} from '#shared/page/types.js'

export interface PagesApi {
  getPages(request?: { display?: PageDisplayFilter }): Promise<PageHostInfo[]>
  openPage(request: unknown): Promise<OpenPageResult>
  closePage(request: unknown): Promise<void>
  reloadPage(request: unknown): Promise<PageHostInfo>
  getHeadlessCount(): Promise<number>
}
