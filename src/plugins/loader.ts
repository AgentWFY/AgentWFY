import path from 'path'
import fs from 'fs'
import { createRequire } from 'node:module'
import { PluginRegistry } from './registry.js'
import type { PluginApi } from './registry.js'
import { getOrCreateAgentDb } from '../db/agent-db.js'
import { getConfigValue, setAgentConfig } from '../settings/config.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ProviderFactory } from '../renderer/src/agent/provider_types.js'

// Use Node's real require (not esbuild's bundled version) so plugins can
// require built-in modules like child_process, crypto, etc.
const nodeRequire = createRequire(import.meta.url)

// Built-in host method names that plugins cannot shadow
const BUILT_IN_METHODS = new Set([
  'runSql', 'read', 'write', 'writeBinary', 'edit', 'ls', 'mkdir', 'remove',
  'find', 'grep', 'getTabs', 'openTab', 'closeTab', 'selectTab', 'reloadTab',
  'captureTab', 'getTabConsoleLogs', 'execTabJs', 'publish', 'waitFor',
  'fetch', 'WebSocket', 'spawnAgent', 'sendToAgent', 'startTask', 'stopTask',
  'input',
])

export function loadPlugins(
  agentRoot: string,
  publish: (topic: string, data: unknown) => void,
  providerRegistry?: ProviderRegistry,
): PluginRegistry {
  const registry = new PluginRegistry()
  const db = getOrCreateAgentDb(agentRoot)
  const rows = db.getEnabledPlugins()

  for (const row of rows) {
    const assetsDir = path.join(agentRoot, '.agentwfy', 'plugin-assets', row.name)
    fs.mkdirSync(assetsDir, { recursive: true })

    try {
      const mod: Record<string, unknown> = { exports: {} }
      const modExports = mod.exports as Record<string, unknown>
      const fn = new Function('module', 'exports', 'require', row.code)
      fn(mod, modExports, nodeRequire)

      const activate = (modExports.activate ?? (mod.exports as Record<string, unknown>).activate) as
        ((api: PluginApi) => { deactivate?: () => void } | void) | undefined
      if (typeof activate !== 'function') {
        console.warn(`[plugins] Skipping ${row.name}: code does not export an activate function`)
        continue
      }

      const api: PluginApi = {
        agentRoot,
        assetsDir,
        publish,
        registerFunction(name: string, handler) {
          if (BUILT_IN_METHODS.has(name)) {
            console.warn(`[plugins] ${row.name}: cannot register '${name}' — conflicts with built-in method`)
            return
          }
          if (registry.functions.has(name)) {
            console.warn(`[plugins] ${row.name}: cannot register '${name}' — already registered by another plugin`)
            return
          }
          registry.functions.set(name, { pluginName: row.name, handler })
        },
        getConfig(name: string, fallback?: unknown): unknown {
          return getConfigValue(agentRoot, name, fallback)
        },
        setConfig(name: string, value: unknown): void {
          setAgentConfig(agentRoot, name, value)
        },
        registerProvider(factory: Parameters<PluginApi['registerProvider']>[0]) {
          if (!providerRegistry) {
            console.warn(`[plugins] ${row.name}: cannot register provider '${factory.id}' — provider registry not available`)
            return
          }
          if (providerRegistry.has(factory.id)) {
            console.warn(`[plugins] ${row.name}: cannot register provider '${factory.id}' — already registered`)
            return
          }
          providerRegistry.register(factory as unknown as ProviderFactory)
          console.log(`[plugins] ${row.name}: registered provider '${factory.id}'`)
        },
      }

      const result = activate(api)
      if (result && typeof result.deactivate === 'function') {
        registry.setDeactivator(row.name, result.deactivate)
      }
      registry.plugins.set(row.name, { name: row.name, description: row.description, version: row.version })
    } catch (err) {
      console.warn(`[plugins] Skipping ${row.name}: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return registry
}
