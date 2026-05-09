import { type WebContents, shell } from 'electron'
import type { AgentTabTools } from '../../ipc/tabs.js'
import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { CommandPaletteManager } from '../../command-palette/manager.js'
import type { EventBus } from '../../event-bus.js'
import type { ProviderRegistry } from '../../providers/registry.js'
import type { FunctionRegistry } from '../function_registry.js'
import { runAgentDbSql } from '../../db/sqlite.js'
import { registerFileOps } from './file_ops.js'
import { registerSql } from './sql.js'
import { registerTabs } from './tabs.js'
import { registerEvents } from './events.js'
import { registerAgent } from './agent.js'
import { registerTasks } from './tasks.js'
import { registerPalette } from './palette.js'

interface BuiltInFunctionDeps {
  agentRoot: string
  rendererWebContents: WebContents
  tabTools: AgentTabTools
  getSessionManager: () => AgentSessionManager
  getTaskRunner: () => TaskRunner
  getCommandPalette: () => CommandPaletteManager
  eventBus: EventBus
  providerRegistry: ProviderRegistry
}

async function findDocsReferencingFunctions(
  agentRoot: string,
  functionNames: string[],
): Promise<Map<string, string[]>> {
  // Only docs whose name contains a dot are not preloaded into the system
  // prompt — those are the ones worth surfacing as a hint.
  const rows = (await runAgentDbSql(agentRoot, {
    sql: "SELECT name, content FROM docs WHERE name LIKE '%.%' ORDER BY name ASC",
  })) as Array<{ name: string; content: string }>

  const result = new Map<string, string[]>()
  for (const fn of functionNames) {
    const callPat = `${fn}(`
    const tickPat = '`' + fn + '`'
    const tickCallPat = '`' + fn + '('
    const matches: string[] = []
    for (const row of rows) {
      const c = row.content
      if (c.includes(callPat) || c.includes(tickPat) || c.includes(tickCallPat)) {
        matches.push(row.name)
      }
    }
    if (matches.length > 0) result.set(fn, matches)
  }
  return result
}

export function registerAllBuiltInFunctions(registry: FunctionRegistry, deps: BuiltInFunctionDeps): void {
  registerFileOps(registry, { agentRoot: deps.agentRoot })
  registerSql(registry, { agentRoot: deps.agentRoot })
  registerTabs(registry, { tabTools: deps.tabTools, agentRoot: deps.agentRoot })
  registerEvents(registry, { eventBus: deps.eventBus })
  registerAgent(registry, { getSessionManager: deps.getSessionManager, rendererWebContents: deps.rendererWebContents })
  registerTasks(registry, { getTaskRunner: deps.getTaskRunner })
  registerPalette(registry, {
    getCommandPalette: deps.getCommandPalette,
  })

  registry.register('getAvailableFunctions', async () => {
    const functions = registry.getFunctionInfo()
    const docsByFn = await findDocsReferencingFunctions(
      deps.agentRoot,
      functions.map((f) => f.name),
    )
    return functions.map((f) => {
      const docs = docsByFn.get(f.name)
      return docs ? { name: f.name, docs } : { name: f.name }
    })
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
