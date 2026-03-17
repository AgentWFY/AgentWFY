import path from 'path'
import fs from 'fs'
import { PluginRegistry } from './registry.js'
import type { PluginApi } from './registry.js'
import { getOrCreateAgentDb } from '../db/agent-db.js'

// Built-in host method names that plugins cannot shadow
const BUILT_IN_METHODS = new Set([
  'runSql', 'read', 'write', 'writeBinary', 'edit', 'ls', 'mkdir', 'remove',
  'find', 'grep', 'getTabs', 'openTab', 'closeTab', 'selectTab', 'reloadTab',
  'captureTab', 'getTabConsoleLogs', 'execTabJs', 'publish', 'waitFor',
  'fetch', 'WebSocket', 'spawnAgent', 'sendToAgent', 'startTask', 'stopTask',
  'ffmpeg', 'ffmpegKill', 'input',
])

export function loadPlugins(agentRoot: string, publish: (topic: string, data: unknown) => void): PluginRegistry {
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
      fn(mod, modExports, require)

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
