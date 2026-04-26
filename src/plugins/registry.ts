import path from 'path'
import fs from 'fs'
import { createRequire } from 'node:module'
import { getConfigValue, setAgentConfig, clearAgentConfig } from '../settings/config.js'
import { PluginResourceTracker } from './resource-tracker.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ProviderFactory } from '../agent/provider_types.js'
import type { FunctionRegistry } from '../runtime/function_registry.js'

// Use Node's real require (not esbuild's bundled version) so plugins can
// require built-in modules like child_process, crypto, etc.
const nodeRequire = createRequire(import.meta.url)

export interface PluginManifest {
  name: string
  title: string
  description: string
  version: string
}

export interface PluginRegisterFunctionOptions {
  /**
   * Hidden functions stay callable via host:call but are excluded from
   * the agent's bound variables and from getAvailableFunctions. Use for
   * internal plumbing (e.g. iterator pumps for streaming APIs) that the
   * agent should not call directly.
   */
  hidden?: boolean
}

export interface PluginApi {
  agentRoot: string
  assetsDir: string
  publish: (topic: string, data: unknown) => void
  registerFunction(
    name: string,
    handler: (params: unknown) => Promise<unknown>,
    options?: PluginRegisterFunctionOptions,
  ): void
  registerProvider(factory: { id: string; name: string; createSession(config: unknown): unknown; restoreSession(config: unknown, state: unknown): unknown }): void
  getConfig(name: string, fallback?: unknown): unknown
  setConfig(name: string, value: unknown): void
}

export class PluginRegistry {
  readonly plugins = new Map<string, PluginManifest>()
  private readonly deactivators = new Map<string, () => void>()
  private readonly trackers = new Map<string, PluginResourceTracker>()
  private readonly agentRoot: string
  private readonly publish: (topic: string, data: unknown) => void
  private readonly providerRegistry: ProviderRegistry | undefined
  private readonly functionRegistry: FunctionRegistry | undefined

  constructor(opts: {
    agentRoot: string
    publish: (topic: string, data: unknown) => void
    providerRegistry?: ProviderRegistry
    functionRegistry?: FunctionRegistry
  }) {
    this.agentRoot = opts.agentRoot
    this.publish = opts.publish
    this.providerRegistry = opts.providerRegistry
    this.functionRegistry = opts.functionRegistry
  }

  loadPlugin(row: { name: string; title: string; description: string; version: string; code: string }): void {
    const assetsDir = path.join(this.agentRoot, '.agentwfy', 'plugin-assets', row.name)
    fs.mkdirSync(assetsDir, { recursive: true })

    try {
      const mod: Record<string, unknown> = { exports: {} }
      const modExports = mod.exports as Record<string, unknown>
      const tracker = new PluginResourceTracker()
      const fn = new Function(
        'module', 'exports', 'require',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        row.code,
      )
      fn(
        mod, modExports, nodeRequire,
        tracker.setTimeout, tracker.setInterval, tracker.clearTimeout, tracker.clearInterval,
      )

      const activate = (modExports.activate ?? (mod.exports as Record<string, unknown>).activate) as
        ((api: PluginApi) => { deactivate?: () => void } | void) | undefined
      if (typeof activate !== 'function') {
        console.warn(`[plugins] Skipping ${row.name}: code does not export an activate function`)
        return
      }

      const api: PluginApi = {
        agentRoot: this.agentRoot,
        assetsDir,
        publish: this.publish,
        registerFunction: (name: string, handler, options?: PluginRegisterFunctionOptions) => {
          if (!this.functionRegistry) {
            console.warn(`[plugins] ${row.name}: cannot register '${name}' — function registry not available`)
            return
          }
          if (this.functionRegistry.has(name)) {
            console.warn(`[plugins] ${row.name}: cannot register '${name}' — already registered`)
            return
          }
          this.functionRegistry.register(name, handler, row.name, { hidden: options?.hidden === true })
        },
        getConfig: (name: string, fallback?: unknown): unknown => {
          return getConfigValue(this.agentRoot, name, fallback)
        },
        setConfig: (name: string, value: unknown): void => {
          setAgentConfig(this.agentRoot, name, value)
        },
        registerProvider: (factory: Parameters<PluginApi['registerProvider']>[0]) => {
          if (!this.providerRegistry) {
            console.warn(`[plugins] ${row.name}: cannot register provider '${factory.id}' — provider registry not available`)
            return
          }
          if (this.providerRegistry.has(factory.id)) {
            console.warn(`[plugins] ${row.name}: cannot register provider '${factory.id}' — already registered`)
            return
          }
          this.providerRegistry.register(factory as unknown as ProviderFactory, row.name)
          console.log(`[plugins] ${row.name}: registered provider '${factory.id}'`)
        },
      }

      const result = activate(api)
      if (result && typeof result.deactivate === 'function') {
        this.deactivators.set(row.name, result.deactivate)
      }
      this.trackers.set(row.name, tracker)
      this.plugins.set(row.name, { name: row.name, title: row.title, description: row.description, version: row.version })
    } catch (err) {
      console.warn(`[plugins] Skipping ${row.name}: failed to load — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Unload then reload a plugin. */
  reloadPlugin(row: { name: string; title: string; description: string; version: string; code: string }): void {
    this.unloadPlugin(row.name)
    this.loadPlugin(row)
  }

  unloadPlugin(name: string): void {
    const deactivator = this.deactivators.get(name)
    if (deactivator) {
      try {
        deactivator()
      } catch (err) {
        console.warn(`[plugins] ${name} deactivate failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.deactivators.delete(name)
    }

    const tracker = this.trackers.get(name)
    if (tracker) {
      const counts = tracker.disposeAll()
      if (counts.timeouts > 0 || counts.intervals > 0) {
        console.log(`[plugins] ${name}: force-cleaned ${counts.timeouts} timeout(s), ${counts.intervals} interval(s)`)
      }
      this.trackers.delete(name)
    }

    this.functionRegistry?.unregisterBySource(name)
    const removedProviders = this.providerRegistry?.unregisterBySource(name) ?? []
    handleProviderFallback(this.agentRoot, removedProviders)

    this.plugins.delete(name)
  }

  deactivateAll(): void {
    for (const [name, fn] of this.deactivators) {
      try {
        fn()
      } catch (err) {
        console.warn(`[plugins] ${name} deactivate failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.deactivators.clear()
    for (const tracker of this.trackers.values()) tracker.disposeAll()
    this.trackers.clear()
    this.plugins.clear()
  }
}

function handleProviderFallback(agentRoot: string, removedProviders: string[]): void {
  if (removedProviders.length === 0) return
  const currentProvider = getConfigValue(agentRoot, 'system.provider') as string | undefined
  if (currentProvider && removedProviders.includes(currentProvider)) {
    clearAgentConfig(agentRoot, 'system.provider')
  }
}
