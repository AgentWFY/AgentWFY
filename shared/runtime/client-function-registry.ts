import { FunctionRegistry } from './function_registry.js'
import type { ExternalLauncher, PaletteHost } from './hosts.js'
import type { WorkerHostMethodMap } from './types.js'
import { registerOpenExternal } from './functions/open_external.js'

export interface PluginConfirmationHost {
  confirmPluginInstall(
    packagePath: string,
    plugins: Array<Record<string, unknown>>,
  ): Promise<boolean>
  confirmPluginToggle(plugin: Record<string, unknown> & { currentEnabled: boolean }): Promise<boolean>
  confirmPluginUninstall(plugin: Record<string, unknown>): Promise<boolean>
}

export interface ClientFunctionRegistryOptions {
  /** Client-side picker UI for runtime functions that need user selection. */
  getPaletteHost?: () => PaletteHost | null | undefined
  /** Confirmation callbacks invoked by daemon-side functions before mutating
   *  server-owned state. Desktop and mobile supply different UI hosts here. */
  getPluginConfirmationHost?: () => Partial<PluginConfirmationHost> | null | undefined
  externalLauncher?: ExternalLauncher
}

export function createClientFunctionRegistry(opts: ClientFunctionRegistryOptions): FunctionRegistry {
  const registry = new FunctionRegistry()

  if (opts.getPaletteHost) {
    registerPickFromPalette(registry, opts.getPaletteHost)
  }

  const getPluginConfirmationHost = opts.getPluginConfirmationHost ?? opts.getPaletteHost
  if (getPluginConfirmationHost) {
    registerPluginConfirmationFunctions(registry, getPluginConfirmationHost)
  }

  if (opts.externalLauncher) {
    registerOpenExternal(registry, opts.externalLauncher)
  }

  return registry
}

function registerPickFromPalette(
  registry: FunctionRegistry,
  getPaletteHost: () => PaletteHost | null | undefined,
): void {
  registry.register('pickFromPalette', async (params) => {
    const host = getPaletteHost()
    if (!host) throw new Error('Command palette is not available')
    return host.pickFromPalette(params as WorkerHostMethodMap['pickFromPalette']['params'])
  })
}

function registerPluginConfirmationFunctions(
  registry: FunctionRegistry,
  getHost: () => Partial<PluginConfirmationHost> | null | undefined,
): void {
  registry.register('_confirmPluginInstall', async (params) => {
    const req = params as { packagePath?: unknown; plugins?: unknown }
    const host = getHost()
    if (!host?.confirmPluginInstall) {
      throw new Error('Plugin install confirmation is not available')
    }
    if (typeof req.packagePath !== 'string' || !Array.isArray(req.plugins)) {
      throw new Error('_confirmPluginInstall requires packagePath and plugins')
    }
    return host.confirmPluginInstall(req.packagePath, req.plugins as Array<Record<string, unknown>>)
  }, 'built-in', { hidden: true })

  registry.register('_confirmPluginToggle', async (params) => {
    const req = params as Record<string, unknown> & { currentEnabled?: unknown }
    const host = getHost()
    if (!host?.confirmPluginToggle) {
      throw new Error('Plugin toggle confirmation is not available')
    }
    if (typeof req.currentEnabled !== 'boolean') {
      throw new Error('_confirmPluginToggle requires currentEnabled')
    }
    return host.confirmPluginToggle(req as Record<string, unknown> & { currentEnabled: boolean })
  }, 'built-in', { hidden: true })

  registry.register('_confirmPluginUninstall', async (params) => {
    const req = params as Record<string, unknown>
    const host = getHost()
    if (!host?.confirmPluginUninstall) {
      throw new Error('Plugin uninstall confirmation is not available')
    }
    return host.confirmPluginUninstall(req)
  }, 'built-in', { hidden: true })
}
