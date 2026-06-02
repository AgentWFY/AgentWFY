import type {
  PageCdpSubscription,
  PageConsoleLog,
  PageHostInfo,
  PageInputRequest,
  PageScreenshot,
} from './types.js'

export interface PageHandle {
  readonly pageId: string
  info(): PageHostInfo
  close(): Promise<void>
  reload(): Promise<void>
  capture?(): Promise<PageScreenshot>
  runJs?(code: string, timeoutMs?: number): Promise<unknown>
  sendInput?(input: PageInputRequest): Promise<void>
  inspectElement?(selector: string): Promise<unknown>
  getConsoleLogs?(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]>
  sendCdp?(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  subscribeCdp?(events: string[]): Promise<PageCdpSubscription>
  detachCdp?(): Promise<void>
}
