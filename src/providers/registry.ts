import type { ProviderFactory, ProviderInfo } from '../renderer/src/agent/provider_types.js'

export class ProviderRegistry {
  private factories = new Map<string, ProviderFactory>()

  register(factory: ProviderFactory): void {
    if (this.factories.has(factory.id)) {
      console.warn(`[providers] Provider '${factory.id}' already registered, overwriting`)
    }
    this.factories.set(factory.id, factory)
  }

  get(id: string): ProviderFactory | undefined {
    return this.factories.get(id)
  }

  list(): ProviderInfo[] {
    return Array.from(this.factories.values()).map(f => ({
      id: f.id,
      name: f.name,
    }))
  }

  has(id: string): boolean {
    return this.factories.has(id)
  }
}
