import type { FunctionRegistry } from '../function_registry.js'
import type {
  PageApi,
  PageDisplay,
  PageDisplayFilter,
  PageSource,
} from '../../page/types.js'
import { formatPageSource, normalizePageSource } from '../../page/page-source.js'
import {
  DEFAULT_HEADLESS_CLOSE_AFTER_IDLE_MS,
  normalizeViewportInput,
  resolveHeadlessCloseAfterIdleMs,
  resolveViewport,
  type HeadlessCloseAfterIdleMs,
  type Viewport,
} from '../hosts.js'
import { getViewByName } from '../../db/views.js'
import type {
  WorkerHostMethodMap,
  WorkerPageConsoleLogEntry,
  WorkerSendPageInputRequest,
} from '../types.js'

const DOCS_HINT = 'Read `@docs/system.pages` for the full function reference.'
const DEBUGGER_DOCS_HINT = 'Read `@docs/system.page-debugger` for the full function reference.'

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function formatViewport(viewport: Viewport): string {
  return `${viewport.width}x${viewport.height}`
}

function buildOpenPageInfo(opts: {
  pageId: string
  source: PageSource
  display: PageDisplay
  viewport?: Viewport
  closeAfterIdleMs?: HeadlessCloseAfterIdleMs
  usedDefaultCloseAfterIdle: boolean
}): string {
  if (opts.display !== 'headless') {
    return `Opened ${opts.display} page ${opts.pageId} for ${formatPageSource(opts.source)}.`
  }

  const viewport = opts.viewport ? formatViewport(opts.viewport) : '1280x720'
  if (opts.closeAfterIdleMs === 'never') {
    return `Opened headless page ${opts.pageId} for ${formatPageSource(opts.source)} (${viewport}). It stays open until closePage is called.`
  }

  const timeoutMs = typeof opts.closeAfterIdleMs === 'number'
    ? opts.closeAfterIdleMs
    : DEFAULT_HEADLESS_CLOSE_AFTER_IDLE_MS
  const suffix = opts.usedDefaultCloseAfterIdle
    ? '; pass closeAfterIdleMs:"never" to keep it open'
    : ''
  return `Opened headless page ${opts.pageId} for ${formatPageSource(opts.source)} (${viewport}). It closes after ${formatDuration(timeoutMs)} idle${suffix}.`
}

function resolvePageId(params: unknown): string {
  if (typeof params === 'string') {
    if (!params.trim()) throw new Error(`requires a page id. ${DOCS_HINT}`)
    return params
  }
  const request = params as { id?: string; pageId?: string } | undefined
  const pageId = request?.pageId ?? request?.id
  if (typeof pageId !== 'string' || !pageId.trim()) {
    throw new Error(`requires a page id (or id). ${DOCS_HINT}`)
  }
  return pageId
}

function normalizeDisplay(value: unknown): PageDisplay {
  if (value === 'foreground' || value === 'background' || value === 'headless') {
    return value
  }
  throw new Error(`openPage requires explicit display: "foreground", "background", or "headless". ${DOCS_HINT}`)
}

function normalizeDisplayFilter(value: unknown): PageDisplayFilter | undefined {
  if (value === undefined || value === null) return undefined
  if (
    value === 'foreground' ||
    value === 'background' ||
    value === 'headless' ||
    value === 'user-facing' ||
    value === 'all'
  ) {
    return value
  }
  throw new Error(`getPages display must be "foreground", "background", "headless", "user-facing", or "all". ${DOCS_HINT}`)
}

export function registerPages(
  registry: FunctionRegistry,
  deps: { pageTools: PageApi; runtimeRoot: string },
): void {
  const { pageTools, runtimeRoot } = deps

  registry.register('getPages', async (params) => {
    const request = (params ?? {}) as { display?: unknown; clientId?: unknown }
    return pageTools.getPages({
      display: normalizeDisplayFilter(request.display),
      ...(typeof request.clientId === 'string' ? { clientId: request.clientId } : {}),
    })
  })

  registry.register('getCurrentPage', async (params) => {
    const request = (params ?? {}) as { clientId?: unknown }
    return pageTools.getCurrentPage({
      ...(typeof request.clientId === 'string' ? { clientId: request.clientId } : {}),
    })
  })

  registry.register('openPage', async (params) => {
    const original = params as WorkerHostMethodMap['openPage']['params']
    if (!original) {
      throw new Error(`openPage requires a request object. ${DOCS_HINT}`)
    }

    const source = normalizePageSource(original.source, { docsHint: DOCS_HINT })
    const display = normalizeDisplay(original.display)
    let resolvedSource = source
    let resolvedTitle = original.title

    if (source.type === 'view') {
      const view = await getViewByName(runtimeRoot, source.name)
      if (!view) {
        throw new Error(`View not found: ${source.name}`)
      }
      resolvedSource = {
        ...source,
        name: view.name,
      }
      if (typeof resolvedTitle !== 'string') {
        resolvedTitle = view.title || view.name
      }
    }

    const viewport = display === 'headless'
      ? resolveViewport(normalizeViewportInput(original))
      : undefined
    const closeAfterIdleMs = display === 'headless'
      ? resolveHeadlessCloseAfterIdleMs(original.closeAfterIdleMs)
      : undefined

    const result = await pageTools.openPage({
      source: resolvedSource,
      display,
      title: resolvedTitle,
      viewport,
      closeAfterIdleMs,
    })

    return {
      id: result.pageId,
      pageId: result.pageId,
      page: result.page,
      info: buildOpenPageInfo({
        pageId: result.pageId,
        source: resolvedSource,
        display,
        viewport,
        closeAfterIdleMs,
        usedDefaultCloseAfterIdle: display === 'headless' && original.closeAfterIdleMs == null,
      }),
    }
  })

  registry.register('showPage', async (params) => {
    const pageId = resolvePageId(params)
    return pageTools.showPage({ pageId })
  })

  registry.register('closePage', async (params) => {
    const pageId = resolvePageId(params)
    await pageTools.closePage({ pageId })
  })

  registry.register('reloadPage', async (params) => {
    const pageId = resolvePageId(params)
    return pageTools.reloadPage({ pageId })
  })

  registry.register('waitForPage', async (params) => {
    const request = params as WorkerHostMethodMap['waitForPage']['params']
    const pageId = resolvePageId(request)
    return pageTools.waitForPage({
      pageId,
      lifecycle: request.lifecycle,
      timeoutMs: request.timeoutMs,
    })
  })

  registry.register('capturePage', async (params) => {
    const request = params as WorkerHostMethodMap['capturePage']['params']
    const pageId = resolvePageId(request)
    return pageTools.capturePage({
      pageId,
      allowFallback: request.allowFallback,
    })
  })

  registry.register('getPageConsoleLogs', async (params) => {
    const request = params as WorkerHostMethodMap['getPageConsoleLogs']['params']
    const pageId = resolvePageId(request)
    const logs = await pageTools.getPageConsoleLogs({
      pageId,
      since: request.since,
      limit: request.limit,
    })
    return logs as WorkerPageConsoleLogEntry[]
  })

  registry.register('runPageJs', async (params) => {
    const request = params as WorkerHostMethodMap['runPageJs']['params']
    const pageId = resolvePageId(request)
    if (typeof request.code !== 'string') {
      throw new Error(`runPageJs requires JavaScript code as a string. ${DOCS_HINT}`)
    }

    return pageTools.runPageJs({
      pageId,
      code: request.code,
      timeoutMs: request.timeoutMs,
    })
  })

  registry.register('sendPageInput', async (params) => {
    const request = params as WorkerSendPageInputRequest
    const pageId = resolvePageId(request)
    if (typeof request.type !== 'string' || !request.type) {
      throw new Error(`sendPageInput requires a type. ${DOCS_HINT}`)
    }

    return pageTools.sendPageInput({
      pageId,
      type: request.type,
      x: request.x,
      y: request.y,
      button: request.button,
      clickCount: request.clickCount,
      deltaX: request.deltaX,
      deltaY: request.deltaY,
      keyCode: request.keyCode,
      modifiers: request.modifiers,
    })
  })

  registry.register('inspectPageElement', async (params) => {
    const request = params as { id?: string; pageId?: string; selector: string }
    const pageId = resolvePageId(request)
    if (typeof request.selector !== 'string' || !request.selector.trim()) {
      throw new Error(`inspectPageElement requires a CSS selector. ${DOCS_HINT}`)
    }

    return pageTools.inspectPageElement({ pageId, selector: request.selector })
  })

  registry.register('sendPageCdp', async (params) => {
    const request = params as WorkerHostMethodMap['sendPageCdp']['params']
    const pageId = resolvePageId(request)
    if (typeof request.method !== 'string' || !request.method.trim()) {
      throw new Error(`sendPageCdp requires a CDP method name. ${DEBUGGER_DOCS_HINT}`)
    }
    return pageTools.sendPageCdp({
      pageId,
      method: request.method,
      params: request.params,
      sessionId: request.sessionId,
    })
  })

  registry.register('subscribePageCdp', async (params) => {
    const request = params as WorkerHostMethodMap['subscribePageCdp']['params']
    const pageId = resolvePageId(request)
    if (!Array.isArray(request.events) || request.events.length === 0) {
      throw new Error(`subscribePageCdp requires a non-empty events array. ${DEBUGGER_DOCS_HINT}`)
    }
    for (const name of request.events) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error(`subscribePageCdp events must be non-empty strings. ${DEBUGGER_DOCS_HINT}`)
      }
    }
    return pageTools.subscribePageCdp({
      pageId,
      events: request.events,
    })
  })

  registry.register('pollPageCdp', async (params) => {
    const request = params as WorkerHostMethodMap['pollPageCdp']['params']
    if (!request || typeof request.subscriptionId !== 'string' || !request.subscriptionId.trim()) {
      throw new Error(`pollPageCdp requires a subscriptionId. ${DEBUGGER_DOCS_HINT}`)
    }
    return pageTools.pollPageCdp({
      subscriptionId: request.subscriptionId,
      maxBatch: request.maxBatch,
      maxWaitMs: request.maxWaitMs,
    })
  }, undefined, { hidden: true })

  registry.register('unsubscribePageCdp', async (params) => {
    let subscriptionId: string | undefined
    if (typeof params === 'string') {
      subscriptionId = params
    } else {
      subscriptionId = (params as { subscriptionId?: string } | undefined)?.subscriptionId
    }
    if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
      throw new Error(`unsubscribePageCdp requires a subscriptionId. ${DEBUGGER_DOCS_HINT}`)
    }
    await pageTools.unsubscribePageCdp({ subscriptionId })
  }, undefined, { hidden: true })

  registry.register('detachPageCdp', async (params) => {
    const pageId = resolvePageId(params)
    await pageTools.detachPageCdp({ pageId })
  })
}
