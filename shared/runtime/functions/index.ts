import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { PaletteHost } from '../hosts.js'
import type { EventBus } from '../../event-bus.js'
import type { ProviderRegistry } from '../../providers/registry.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { ExternalLauncher, NotificationHost, RendererPush } from '../hosts.js'
import type { PageApi } from '../../page/types.js'
import type { FileStore } from '../../storage/file-store.js'
import { runAgentDbSql } from '../../db/sqlite.js'
import { registerFileOps } from './file_ops.js'
import { registerSql } from './sql.js'
import { registerPages } from './pages.js'
import { registerEvents } from './events.js'
import { registerAgent } from './agent.js'
import { registerTasks } from './tasks.js'
import { registerPalette } from './palette.js'
import { registerOpenExternal } from './open_external.js'
import { registerNotify } from './notify.js'

interface BuiltInFunctionDeps {
  runtimeRoot: string
  /** Agent file tree access (node:fs on the desktop/daemon). */
  store: FileStore
  getSessionManager: () => AgentSessionManager
  getTaskRunner: () => TaskRunner
  eventBus: EventBus
  providerRegistry: ProviderRegistry
  /** Page support — when absent, page functions are not registered. */
  pageTools?: PageApi
  /** Command palette host — when absent, palette functions are not registered. */
  getCommandPalette?: () => PaletteHost
  /** Renderer signal channel — when absent, UI nudges from runtime functions are skipped. */
  rendererPush?: RendererPush
  /** Open URLs in the user's browser — when absent, openExternal is not registered. */
  externalLauncher?: ExternalLauncher
  /** System notifications — when absent, notify is not registered. */
  notificationHost?: NotificationHost
}

async function findDocsReferencingFunctions(
  runtimeRoot: string,
  functionNames: string[],
): Promise<Map<string, string[]>> {
  // Only docs whose name contains a dot are not preloaded into the system
  // prompt — those are the ones worth surfacing as a hint.
  const rows = (await runAgentDbSql(runtimeRoot, {
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
  registerFileOps(registry, { runtimeRoot: deps.runtimeRoot, store: deps.store })
  registerSql(registry, { runtimeRoot: deps.runtimeRoot })
  if (deps.pageTools) {
    registerPages(registry, { pageTools: deps.pageTools, runtimeRoot: deps.runtimeRoot })
  }
  registerEvents(registry, { eventBus: deps.eventBus })
  registerAgent(registry, {
    getSessionManager: deps.getSessionManager,
    ...(deps.rendererPush ? { rendererPush: deps.rendererPush } : {}),
  })
  registerTasks(registry, { getTaskRunner: deps.getTaskRunner })
  if (deps.getCommandPalette) {
    registerPalette(registry, { getCommandPalette: deps.getCommandPalette })
  }

  registry.register('getAvailableFunctions', async () => {
    const functions = registry.getFunctionInfo()
    const docsByFn = await findDocsReferencingFunctions(
      deps.runtimeRoot,
      functions.map((f) => f.name),
    )
    return functions.map((f) => {
      const docs = docsByFn.get(f.name)
      return docs ? { name: f.name, docs } : { name: f.name }
    })
  })

  registry.register('getAvailableProviders', async () => {
    return deps.providerRegistry.list()
  })

  if (deps.externalLauncher) {
    registerOpenExternal(registry, deps.externalLauncher)
  }

  if (deps.notificationHost) {
    registerNotify(registry, deps.notificationHost)
  }
}

export { registerOpenExternal } from './open_external.js'
export { registerNotify } from './notify.js'
