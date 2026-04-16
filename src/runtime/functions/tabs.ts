import type { AgentTabTools } from '../../ipc/tabs.js'
import { getViewByName } from '../../db/views.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap, WorkerTabConsoleLogEntry, WorkerSendInputRequest } from '../types.js'

const DOCS_HINT = 'Read `@docs/system.tabs` for the full function reference.'

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

export function registerTabs(registry: FunctionRegistry, deps: { tabTools: AgentTabTools; agentRoot: string }): void {
  const { tabTools, agentRoot } = deps

  registry.register('getTabs', async () => {
    return tabTools.getTabs()
  })

  registry.register('openTab', async (params) => {
    const request = params as WorkerHostMethodMap['openTab']['params']
    if (!request) {
      throw new Error(`openTab requires a request object. ${DOCS_HINT}`)
    }

    // Validate viewName exists and resolve title
    const hasViewName = typeof request.viewName === 'string' && request.viewName.length > 0
    let resolvedViewName = request.viewName
    let resolvedTitle = request.title
    if (hasViewName) {
      const view = await getViewByName(agentRoot, request.viewName!)
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

    const result = await tabTools.openTab({
      viewName: hasResolvedViewName ? resolvedViewName : undefined,
      filePath: hasFilePath ? request.filePath : undefined,
      url: hasUrl ? request.url : undefined,
      title: resolvedTitle,
      hidden: request.hidden,
      params: request.params,
    })

    return { id: result.tabId, tabId: result.tabId }
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
}
