import type { ProviderFactory, ProviderInfo } from '../agent/provider_types.js'

const BUILT_IN_SOURCE = 'built-in'

interface RegisteredProvider {
  factory: ProviderFactory
  source: string
}

export class ProviderRegistry {
  private factories = new Map<string, RegisteredProvider>()

  register(factory: ProviderFactory, source = BUILT_IN_SOURCE): void {
    if (this.factories.has(factory.id)) {
      console.warn(`[providers] Provider '${factory.id}' already registered, overwriting`)
    }
    this.factories.set(factory.id, { factory, source })
  }

  get(id: string): ProviderFactory | undefined {
    return this.factories.get(id)?.factory
  }

  list(): ProviderInfo[] {
    return Array.from(this.factories.values()).map(({ factory: f }) => ({
      id: f.id,
      name: f.name,
      ...(f.settingsView ? { settingsView: f.settingsView } : {}),
    }))
  }

  has(id: string): boolean {
    return this.factories.has(id)
  }

  unregisterBySource(source: string): string[] {
    const removed: string[] = []
    for (const [id, entry] of this.factories) {
      if (entry.source === source) {
        this.factories.delete(id)
        removed.push(id)
      }
    }
    return removed
  }
}
