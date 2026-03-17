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
}

interface RegisteredFunction {
  pluginName: string
  handler: (params: unknown) => Promise<unknown>
}

export class PluginRegistry {
  readonly functions = new Map<string, RegisteredFunction>()
  readonly plugins = new Map<string, PluginManifest>()
  private readonly deactivators = new Map<string, () => void>()

  async call(methodName: string, params: unknown): Promise<unknown> {
    const entry = this.functions.get(methodName)
    if (!entry) {
      throw new Error(`Unknown plugin function: ${methodName}`)
    }

    try {
      return await entry.handler(params)
    } catch (err) {
      throw new Error(
        `Plugin function '${methodName}' (${entry.pluginName}) failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  getMethodNames(): string[] {
    return Array.from(this.functions.keys())
  }

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
    this.functions.clear()
    this.plugins.clear()
  }

  getPluginList(): Array<{ name: string; description: string }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      description: p.description,
    }))
  }
}
