import type {
  OpenPageResult,
  PageHostInfo,
} from '#shared/page/types.js'

export interface PagesApi {
  getPages(request?: { headless?: boolean }): Promise<PageHostInfo[]>
  openClientPage(request: unknown): Promise<OpenPageResult>
  closePage(request: unknown): Promise<void>
  reloadPage(request: unknown): Promise<PageHostInfo>
  getHeadlessCount(): Promise<number>
}
