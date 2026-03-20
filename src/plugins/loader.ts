import { PluginRegistry } from './registry.js'
import { getOrCreateAgentDb } from '../db/agent-db.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { FunctionRegistry } from '../runtime/function_registry.js'

export function loadPlugins(
  agentRoot: string,
  publish: (topic: string, data: unknown) => void,
  providerRegistry?: ProviderRegistry,
  functionRegistry?: FunctionRegistry,
): PluginRegistry {
  const registry = new PluginRegistry({ agentRoot, publish, providerRegistry, functionRegistry })
  const db = getOrCreateAgentDb(agentRoot)
  const rows = db.getEnabledPlugins()

  for (const row of rows) {
    registry.loadPlugin(row)
  }

  return registry
}
