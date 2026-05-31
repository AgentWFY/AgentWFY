import type { PageHandle } from './page-handle.js'
import type { PageCapabilities } from './types.js'

export const EMPTY_PAGE_CAPABILITIES: PageCapabilities = {
  screenshot: false,
  js: false,
  input: false,
  consoleLogs: false,
  inspect: false,
  cdp: false,
  screencast: false,
}

export function pageCapabilitiesFromHandleMethods(
  handle: Partial<PageHandle>,
  overrides: Partial<PageCapabilities> = {},
): PageCapabilities {
  return {
    screenshot: typeof handle.capture === 'function',
    js: typeof handle.runJs === 'function',
    input: typeof handle.sendInput === 'function',
    consoleLogs: typeof handle.getConsoleLogs === 'function',
    inspect: typeof handle.inspectElement === 'function',
    cdp: typeof handle.sendCdp === 'function' || typeof handle.subscribeCdp === 'function',
    screencast: false,
    ...overrides,
  }
}
