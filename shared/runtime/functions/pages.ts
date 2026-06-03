import type { FunctionRegistry } from '../function_registry.js'
import type {
  PageApi,
  PageCloseAfterIdleMs,
  PageHostInfo,
  PageInfo,
  PageQueryRequest,
  PageViewport,
  PageSource,
} from '../../page/types.js'
import { formatPageSource, normalizePageSource } from '../../page/page-source.js'
import {
  DEFAULT_PAGE_CLOSE_AFTER_IDLE_MS,
  resolvePageCloseAfterIdleMs,
} from '../../page/idle-close.js'
import { normalizePageViewportInput, resolvePageViewport } from '../../page/page-viewport.js'
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

function formatViewport(viewport: PageViewport): string {
  return `${viewport.width}x${viewport.height}`
}

function buildOpenPageInfo(opts: {
  pageId: string
  source: PageSource
  viewport?: PageViewport
  closeAfterIdleMs?: PageCloseAfterIdleMs
  usedDefaultCloseAfterIdle: boolean
}): string {
  const viewport = opts.viewport ? formatViewport(opts.viewport) : '1280x720'
  if (opts.closeAfterIdleMs === 'never') {
    return `Opened headless page ${opts.pageId} for ${formatPageSource(opts.source)} (${viewport}). It stays open until closePage is called.`
  }

  const timeoutMs = typeof opts.closeAfterIdleMs === 'number'
    ? opts.closeAfterIdleMs
    : DEFAULT_PAGE_CLOSE_AFTER_IDLE_MS
  const suffix = opts.usedDefaultCloseAfterIdle
    ? '; pass closeAfterIdleMs:"never" to keep it open'
    : ''
  return `Opened headless page ${opts.pageId} for ${formatPageSource(opts.source)} (${viewport}). It closes after ${formatDuration(timeoutMs)} idle${suffix}.`
}

function buildOpenClientPageInfo(opts: {
  pageId: string
  source: PageSource
}): string {
  return `Opened client page ${opts.pageId} for ${formatPageSource(opts.source)}.`
}

function toPageInfo(page: PageHostInfo): PageInfo {
  return {
    pageId: page.pageId,
    title: page.title,
    source: page.source,
    headless: page.headless,
  }
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

function getPagesQuery(params: unknown): PageQueryRequest {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`getPages requires an options object when arguments are provided. ${DOCS_HINT}`)
  }
  const request = params as { headless?: unknown }
  for (const key of Object.keys(params)) {
    if (key !== 'headless') {
      throw new Error(`getPages does not accept option "${key}". ${DOCS_HINT}`)
    }
  }
  if (request.headless === undefined || request.headless === null) return {}
  if (typeof request.headless !== 'boolean') {
    throw new Error(`getPages headless must be a boolean. ${DOCS_HINT}`)
  }
  return { headless: request.headless }
}

function validateOptions(functionName: string, params: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`${functionName} does not accept option "${key}". ${DOCS_HINT}`)
    }
  }
}

const OPEN_PAGE_OPTIONS = new Set(['source', 'title', 'width', 'height', 'closeAfterIdleMs'])
const OPEN_CLIENT_PAGE_OPTIONS = new Set(['source', 'title'])

export function registerPages(
  registry: FunctionRegistry,
  deps: { pageTools: PageApi; runtimeRoot: string },
): void {
  const { pageTools, runtimeRoot } = deps

  registry.register('getPages', async (params) => {
    const pages = await pageTools.getPages(getPagesQuery(params))
    return pages.map(toPageInfo)
  })

  registry.register('getCurrentClientPage', async () => {
    const page = await pageTools.getCurrentClientPage()
    return page ? toPageInfo(page) : null
  })

  registry.register('openPage', async (params) => {
    const original = params as WorkerHostMethodMap['openPage']['params']
    if (!original || typeof original !== 'object' || Array.isArray(original)) {
      throw new Error(`openPage requires a request object. ${DOCS_HINT}`)
    }

    const rawRequest = original as unknown as Record<string, unknown>
    validateOptions('openPage', rawRequest, OPEN_PAGE_OPTIONS)
    const source = normalizePageSource(original.source, { docsHint: DOCS_HINT })
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

    const viewport = resolvePageViewport(normalizePageViewportInput(original))
    const closeAfterIdleMs = resolvePageCloseAfterIdleMs(original.closeAfterIdleMs)

    const result = await pageTools.openPage({
      source: resolvedSource,
      title: resolvedTitle,
      viewport,
      closeAfterIdleMs,
    })

    return {
      id: result.pageId,
      pageId: result.pageId,
      page: toPageInfo(result.page),
      info: buildOpenPageInfo({
        pageId: result.pageId,
        source: resolvedSource,
        viewport,
        closeAfterIdleMs,
        usedDefaultCloseAfterIdle: original.closeAfterIdleMs == null,
      }),
    }
  })

  registry.register('openClientPage', async (params) => {
    const original = params as WorkerHostMethodMap['openClientPage']['params']
    if (!original || typeof original !== 'object' || Array.isArray(original)) {
      throw new Error(`openClientPage requires a request object. ${DOCS_HINT}`)
    }

    const rawRequest = original as unknown as Record<string, unknown>
    validateOptions('openClientPage', rawRequest, OPEN_CLIENT_PAGE_OPTIONS)
    const source = normalizePageSource(original.source, { docsHint: DOCS_HINT })
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

    const result = await pageTools.openClientPage({
      source: resolvedSource,
      title: resolvedTitle,
    })

    return {
      id: result.pageId,
      pageId: result.pageId,
      page: toPageInfo(result.page),
      info: buildOpenClientPageInfo({
        pageId: result.pageId,
        source: resolvedSource,
      }),
    }
  })

  registry.register('closePage', async (params) => {
    const pageId = resolvePageId(params)
    await pageTools.closePage({ pageId })
  })

  registry.register('reloadPage', async (params) => {
    const pageId = resolvePageId(params)
    return toPageInfo(await pageTools.reloadPage({ pageId }))
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
