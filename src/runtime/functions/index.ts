import { type WebContents, shell } from 'electron'
import type { OnDbChange } from '../../db/sqlite.js'
import type { AgentTabTools } from '../../ipc/tabs.js'
import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { CommandPaletteManager } from '../../command-palette/manager.js'
import type { EventBus } from '../../event-bus.js'
import type { ProviderRegistry } from '../../providers/registry.js'
import type { FunctionRegistry } from '../function_registry.js'
import { registerFileOps } from './file_ops.js'
import { registerSql } from './sql.js'
import { registerTabs } from './tabs.js'
import { registerEvents } from './events.js'
import { registerAgent } from './agent.js'
import { registerTasks } from './tasks.js'
import { registerPlugins } from './plugins.js'

interface BuiltInFunctionDeps {
  agentRoot: string
  rendererWebContents: WebContents
  tabTools: AgentTabTools
  onDbChange?: OnDbChange
  getSessionManager: () => AgentSessionManager
  getTaskRunner: () => TaskRunner
  getCommandPalette: () => CommandPaletteManager
  eventBus: EventBus
  providerRegistry: ProviderRegistry
}

export function registerAllBuiltInFunctions(registry: FunctionRegistry, deps: BuiltInFunctionDeps): void {
  registerFileOps(registry, { agentRoot: deps.agentRoot })
  registerSql(registry, { agentRoot: deps.agentRoot, onDbChange: deps.onDbChange })
  registerTabs(registry, { tabTools: deps.tabTools, agentRoot: deps.agentRoot })
  registerEvents(registry, { eventBus: deps.eventBus })
  registerAgent(registry, { getSessionManager: deps.getSessionManager, rendererWebContents: deps.rendererWebContents })
  registerTasks(registry, { getTaskRunner: deps.getTaskRunner })
  registerPlugins(registry, {
    getCommandPalette: deps.getCommandPalette,
  })

  registry.register('getAvailableFunctions', async () => {
    return registry.getFunctionInfo()
  })

  registry.register('getAvailableProviders', async () => {
    return deps.providerRegistry.list().map(({ id, name }) => ({ id, name }))
  })

  registry.register('openExternal', async (params) => {
    const { url } = params as { url: string }
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error('openExternal requires a non-empty url string')
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Invalid URL passed to openExternal')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('openExternal only supports http/https URLs')
    }
    await shell.openExternal(parsed.toString())
  })
}
