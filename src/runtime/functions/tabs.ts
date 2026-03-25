import type { AgentTabTools } from '../../ipc/tabs.js'
import { getViewByName } from '../../db/views.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap, WorkerTabConsoleLogEntry } from '../types.js'

export function registerTabs(registry: FunctionRegistry, deps: { tabTools: AgentTabTools; agentRoot: string }): void {
  const { tabTools, agentRoot } = deps

  registry.register('getTabs', async () => {
    return tabTools.getTabs()
  })

  registry.register('openTab', async (params) => {
    const request = params as WorkerHostMethodMap['openTab']['params']
    if (!request) {
      throw new Error('openTab requires a request object')
    }

    // Resolve viewName → viewId
    const hasViewName = typeof request.viewName === 'string' && request.viewName.length > 0
    let resolvedViewId = request.viewId
    let resolvedTitle = request.title
    if (hasViewName) {
      const view = await getViewByName(agentRoot, request.viewName!)
      if (!view) {
        throw new Error(`View not found: ${request.viewName}`)
      }
      resolvedViewId = view.id
      if (typeof resolvedTitle !== 'string') {
        resolvedTitle = view.title || view.name
      }
    }

    const hasViewId = typeof resolvedViewId === 'string' || typeof resolvedViewId === 'number'
    const hasFilePath = typeof request.filePath === 'string' && request.filePath.length > 0
    const hasUrl = typeof request.url === 'string' && request.url.length > 0
    const sourceCount = (hasViewId ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0)

    if (sourceCount !== 1) {
      throw new Error('openTab requires exactly one of viewId, viewName, filePath, or url')
    }

    return tabTools.openTab({
      viewId: hasViewId ? resolvedViewId : undefined,
      filePath: hasFilePath ? request.filePath : undefined,
      url: hasUrl ? request.url : undefined,
      title: resolvedTitle,
      hidden: request.hidden,
      params: request.params,
    })
  })

  registry.register('closeTab', async (params) => {
    const request = params as WorkerHostMethodMap['closeTab']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('closeTab requires a tabId')
    }

    await tabTools.closeTab({ tabId: request.tabId })
    return undefined
  })

  registry.register('selectTab', async (params) => {
    const request = params as WorkerHostMethodMap['selectTab']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('selectTab requires a tabId')
    }

    await tabTools.selectTab({ tabId: request.tabId })
    return undefined
  })

  registry.register('reloadTab', async (params) => {
    const request = params as WorkerHostMethodMap['reloadTab']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('reloadTab requires a tabId')
    }

    await tabTools.reloadTab({ tabId: request.tabId })
    return undefined
  })

  registry.register('captureTab', async (params) => {
    const request = params as WorkerHostMethodMap['captureTab']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('captureTab requires a tabId')
    }

    return tabTools.captureTab({ tabId: request.tabId })
  })

  registry.register('getTabConsoleLogs', async (params) => {
    const request = params as WorkerHostMethodMap['getTabConsoleLogs']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('getTabConsoleLogs requires a tabId')
    }

    const logs = await tabTools.getTabConsoleLogs({
      tabId: request.tabId,
      since: request.since,
      limit: request.limit,
    })
    return logs as WorkerTabConsoleLogEntry[]
  })

  registry.register('execTabJs', async (params) => {
    const request = params as WorkerHostMethodMap['execTabJs']['params']
    if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
      throw new Error('execTabJs requires a tabId')
    }
    if (typeof request.code !== 'string') {
      throw new Error('execTabJs requires JavaScript code as a string')
    }

    return tabTools.execTabJs({
      tabId: request.tabId,
      code: request.code,
      timeoutMs: request.timeoutMs,
    })
  })
}
