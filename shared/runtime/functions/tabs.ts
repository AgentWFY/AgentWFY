import crypto from 'crypto'
import type { TabApi } from '../hosts.js'
import {
  DEFAULT_HEADLESS_CLOSE_AFTER_IDLE_MS,
  normalizeViewportInput,
  resolveHeadlessCloseAfterIdleMs,
  resolveViewport,
  type HeadlessCloseAfterIdleMs,
  type Viewport,
} from '../hosts.js'
import { getViewByName } from '../../db/views.js'
import type { FunctionRegistry } from '../function_registry.js'
import type {
  WorkerHostMethodMap,
  WorkerTabConsoleLogEntry,
  WorkerSendInputRequest,
} from '../types.js'

const DOCS_HINT = 'Read `@docs/system.tabs` for the full function reference.'
const DEBUGGER_DOCS_HINT = 'Read `@docs/system.tab-debugger` for the full function reference.'

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function formatSource(input: { viewName?: string; filePath?: string; url?: string }): string {
  if (input.viewName) return `view "${input.viewName}"`
  if (input.filePath) return `file "${input.filePath}"`
  if (input.url) return `url "${input.url}"`
  return 'unknown source'
}

function formatViewport(viewport: Viewport): string {
  return `${viewport.width}x${viewport.height}`
}

function buildOpenTabInfo(opts: {
  tabId: string
  source: string
  headless: boolean
  viewport?: Viewport
  closeAfterIdleMs?: HeadlessCloseAfterIdleMs
  usedDefaultCloseAfterIdle: boolean
}): string {
  if (!opts.headless) {
    return `Opened visible tab ${opts.tabId} for ${opts.source}. Visible tabs stay open until closed.`
  }

  const viewport = opts.viewport ? formatViewport(opts.viewport) : '1280x720'
  if (opts.closeAfterIdleMs === 'never') {
    return `Opened headless tab ${opts.tabId} for ${opts.source} (${viewport}). It stays open until closeTab is called.`
  }

  const timeoutMs = typeof opts.closeAfterIdleMs === 'number'
    ? opts.closeAfterIdleMs
    : DEFAULT_HEADLESS_CLOSE_AFTER_IDLE_MS
  const suffix = opts.usedDefaultCloseAfterIdle
    ? '; pass closeAfterIdleMs:"never" to keep it open'
    : ''
  return `Opened headless tab ${opts.tabId} for ${opts.source} (${viewport}). It closes after ${formatDuration(timeoutMs)} idle${suffix}.`
}

function resolveTabId(params: unknown): string {
  if (typeof params === 'string') {
    if (!params.trim()) throw new Error(`requires an id. ${DOCS_HINT}`)
    return params
  }
  const request = params as { id?: string; tabId?: string } | undefined
  const tabId = request?.tabId ?? request?.id
  if (typeof tabId !== 'string' || !tabId.trim()) {
    throw new Error(`requires an id (or tabId). ${DOCS_HINT}`)
  }
  return tabId
}

export function registerTabs(
  registry: FunctionRegistry,
  deps: { tabTools: TabApi; runtimeRoot: string },
): void {
  const { tabTools, runtimeRoot } = deps

  registry.register('getTabs', async () => {
    return tabTools.getTabs()
  })

  registry.register('getCurrentTab', async () => {
    return tabTools.getCurrentTab()
  })

  registry.register('openTab', async (params) => {
    const original = params as WorkerHostMethodMap['openTab']['params']
    if (!original) {
      throw new Error(`openTab requires a request object. ${DOCS_HINT}`)
    }

    const request = { ...original }
    if (typeof request.headless !== 'boolean') {
      throw new Error(`openTab requires headless to be set by the runtime binding. ${DOCS_HINT}`)
    }
    if (typeof request.viewName !== 'string' && typeof request.view === 'string') {
      request.viewName = request.view
    }
    request.view = undefined

    // Validate viewName exists and resolve title
    const hasViewName = typeof request.viewName === 'string' && request.viewName.length > 0
    let resolvedViewName = request.viewName
    let resolvedTitle = request.title
    if (hasViewName) {
      const view = await getViewByName(runtimeRoot, request.viewName!)
      if (!view) {
        throw new Error(`View not found: ${request.viewName}`)
      }
      resolvedViewName = view.name
      if (typeof resolvedTitle !== 'string') {
        resolvedTitle = view.title || view.name
      }
    }

    const hasResolvedViewName = typeof resolvedViewName === 'string' && resolvedViewName.length > 0
    const hasFilePath = typeof request.filePath === 'string' && request.filePath.length > 0
    const hasUrl = typeof request.url === 'string' && request.url.length > 0
    const sourceCount = (hasResolvedViewName ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0)

    if (sourceCount !== 1) {
      throw new Error(`openTab requires exactly one of viewName, filePath, or url. ${DOCS_HINT}`)
    }

    const viewport = request.headless ? resolveViewport(normalizeViewportInput(request)) : undefined
    const closeAfterIdleMs = request.headless
      ? resolveHeadlessCloseAfterIdleMs(request.closeAfterIdleMs)
      : undefined
    const source = formatSource({
      viewName: hasResolvedViewName ? resolvedViewName : undefined,
      filePath: hasFilePath ? request.filePath : undefined,
      url: hasUrl ? request.url : undefined,
    })

    const result = await tabTools.openTab({
      viewName: hasResolvedViewName ? resolvedViewName : undefined,
      filePath: hasFilePath ? request.filePath : undefined,
      url: hasUrl ? request.url : undefined,
      title: resolvedTitle,
      headless: request.headless,
      viewport,
      closeAfterIdleMs,
      params: request.params,
    })

    return {
      id: result.tabId,
      tabId: result.tabId,
      info: buildOpenTabInfo({
        tabId: result.tabId,
        source,
        headless: request.headless,
        viewport,
        closeAfterIdleMs,
        usedDefaultCloseAfterIdle: request.headless && request.closeAfterIdleMs == null,
      }),
    }
  })

  registry.register('closeTab', async (params) => {
    const tabId = resolveTabId(params)

    await tabTools.closeTab({ tabId })
    return undefined
  })

  registry.register('selectTab', async (params) => {
    const tabId = resolveTabId(params)

    await tabTools.selectTab({ tabId })
    return undefined
  })

  registry.register('reloadTab', async (params) => {
    const tabId = resolveTabId(params)

    await tabTools.reloadTab({ tabId })
    return undefined
  })

  registry.register('captureTab', async (params) => {
    const tabId = resolveTabId(params)

    return tabTools.captureTab({ tabId })
  })

  registry.register('getTabConsoleLogs', async (params) => {
    const request = params as WorkerHostMethodMap['getTabConsoleLogs']['params']
    const tabId = resolveTabId(request)

    const logs = await tabTools.getTabConsoleLogs({
      tabId,
      since: request.since,
      limit: request.limit,
    })
    return logs as WorkerTabConsoleLogEntry[]
  })

  registry.register('execTabJs', async (params) => {
    const request = params as WorkerHostMethodMap['execTabJs']['params']
    const tabId = resolveTabId(request)
    if (typeof request.code !== 'string') {
      throw new Error(`execTabJs requires JavaScript code as a string. ${DOCS_HINT}`)
    }

    return tabTools.execTabJs({
      tabId,
      code: request.code,
      timeoutMs: request.timeoutMs,
    })
  })

  registry.register('sendInput', async (params) => {
    const request = params as WorkerSendInputRequest
    const tabId = resolveTabId(request)
    if (typeof request.type !== 'string' || !request.type) {
      throw new Error(`sendInput requires a type. ${DOCS_HINT}`)
    }

    return tabTools.sendInput({
      tabId,
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

  registry.register('inspectElement', async (params) => {
    const request = params as { id?: string; tabId?: string; selector: string }
    const tabId = resolveTabId(request)
    if (typeof request.selector !== 'string' || !request.selector.trim()) {
      throw new Error(`inspectElement requires a CSS selector. ${DOCS_HINT}`)
    }

    return tabTools.inspectElement({ tabId, selector: request.selector })
  })

  registry.register('tabDebuggerSend', async (params) => {
    const request = params as WorkerHostMethodMap['tabDebuggerSend']['params']
    const tabId = resolveTabId(request)
    if (typeof request.method !== 'string' || !request.method.trim()) {
      throw new Error(`tabDebuggerSend requires a CDP method name. ${DEBUGGER_DOCS_HINT}`)
    }
    return tabTools.tabDebuggerSend({
      tabId,
      method: request.method,
      params: request.params,
      sessionId: request.sessionId,
    })
  })

  registry.register('tabDebuggerSubscribe', async (params) => {
    const request = params as WorkerHostMethodMap['tabDebuggerSubscribe']['params']
    const tabId = resolveTabId(request)
    if (!Array.isArray(request.events) || request.events.length === 0) {
      throw new Error(`tabDebuggerSubscribe requires a non-empty events array. ${DEBUGGER_DOCS_HINT}`)
    }
    for (const name of request.events) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error(`tabDebuggerSubscribe events must be non-empty strings. ${DEBUGGER_DOCS_HINT}`)
      }
    }
    const subscriptionId = `tabdbg-${crypto.randomBytes(8).toString('hex')}`
    await tabTools.tabDebuggerSubscribe({
      tabId,
      subscriptionId,
      events: request.events,
    })
    return { subscriptionId }
  })

  registry.register('tabDebuggerPoll', async (params) => {
    const request = params as WorkerHostMethodMap['tabDebuggerPoll']['params']
    if (!request || typeof request.subscriptionId !== 'string' || !request.subscriptionId.trim()) {
      throw new Error(`tabDebuggerPoll requires a subscriptionId. ${DEBUGGER_DOCS_HINT}`)
    }
    return tabTools.tabDebuggerPoll({
      subscriptionId: request.subscriptionId,
      maxBatch: request.maxBatch,
      maxWaitMs: request.maxWaitMs,
    })
  }, undefined, { hidden: true })

  registry.register('tabDebuggerUnsubscribe', async (params) => {
    let subscriptionId: string | undefined
    if (typeof params === 'string') {
      subscriptionId = params
    } else {
      subscriptionId = (params as { subscriptionId?: string } | undefined)?.subscriptionId
    }
    if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
      throw new Error(`tabDebuggerUnsubscribe requires a subscriptionId. ${DEBUGGER_DOCS_HINT}`)
    }
    await tabTools.tabDebuggerUnsubscribe({ subscriptionId })
  }, undefined, { hidden: true })

  registry.register('tabDebuggerDetach', async (params) => {
    const tabId = resolveTabId(params)
    await tabTools.tabDebuggerDetach({ tabId })
  })
}
