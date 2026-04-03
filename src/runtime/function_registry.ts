type FunctionHandler = (params: unknown) => Promise<unknown>

const BUILT_IN_SOURCE = 'built-in'

interface RegisteredFunction {
  handler: FunctionHandler
  source: string
}

export class FunctionRegistry {
  private readonly handlers = new Map<string, RegisteredFunction>()
  private cachedMethodNames: string[] | null = null

  register(name: string, handler: FunctionHandler, source = BUILT_IN_SOURCE): void {
    this.handlers.set(name, { handler, source })
    this.cachedMethodNames = null
  }

  async call(name: string, params: unknown): Promise<unknown> {
    const entry = this.handlers.get(name)
    if (!entry) {
      throw new Error(`Unknown function: ${name}`)
    }
    try {
      return await entry.handler(params)
    } catch (err) {
      const label = entry.source === BUILT_IN_SOURCE ? name : `${name} (${entry.source})`
      throw new Error(
        `${label}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  has(name: string): boolean {
    return this.handlers.has(name)
  }

  getMethodNames(): string[] {
    if (this.cachedMethodNames) return this.cachedMethodNames
    this.cachedMethodNames = Array.from(this.handlers.keys())
    return this.cachedMethodNames
  }

  getPluginMethodNames(): string[] {
    return Array.from(this.handlers.entries())
      .filter(([, entry]) => entry.source !== BUILT_IN_SOURCE)
      .map(([name]) => name)
  }

  getFunctionInfo(): Array<{ name: string; source: string }> {
    return Array.from(this.handlers.entries()).map(([name, entry]) => ({
      name,
      source: entry.source,
    }))
  }

  unregisterBySource(source: string): void {
    let didRemove = false
    for (const [name, entry] of this.handlers) {
      if (entry.source === source) {
        this.handlers.delete(name)
        didRemove = true
      }
    }
    if (didRemove) this.cachedMethodNames = null
  }
}
