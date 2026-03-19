export interface PluginManifest {
  name: string
  description: string
  version: string
}

export interface PluginApi {
  agentRoot: string
  assetsDir: string
  publish: (topic: string, data: unknown) => void
  registerFunction(name: string, handler: (params: unknown) => Promise<unknown>): void
  registerProvider(factory: { id: string; name: string; createSession(config: unknown): unknown; restoreSession(config: unknown, state: unknown): unknown }): void
  getConfig(name: string, fallback?: unknown): unknown
  setConfig(name: string, value: unknown): void
}

export class PluginRegistry {
  readonly plugins = new Map<string, PluginManifest>()
  private readonly deactivators = new Map<string, () => void>()

  setDeactivator(pluginName: string, fn: () => void): void {
    this.deactivators.set(pluginName, fn)
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
    this.plugins.clear()
  }

  getPluginList(): Array<{ name: string; description: string }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      description: p.description,
    }))
  }
}
