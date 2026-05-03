import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'
import type { CommandPaletteManager } from '../../command-palette/manager.js'

const DOCS_HINT = 'Read `@docs/system.plugins.guide` for the full function reference.'

export function registerPalette(
  registry: FunctionRegistry,
  deps: {
    getCommandPalette: () => CommandPaletteManager
  },
): void {
  const { getCommandPalette } = deps

  registry.register('requestInstallPlugin', async (params) => {
    const request = params as WorkerHostMethodMap['requestInstallPlugin']['params']
    if (!request || typeof request.packagePath !== 'string' || request.packagePath.trim().length === 0) {
      throw new Error(`requestInstallPlugin requires a non-empty packagePath string. ${DOCS_HINT}`)
    }
    return getCommandPalette().requestPluginInstall(request.packagePath)
  })

  registry.register('requestTogglePlugin', async (params) => {
    const request = params as WorkerHostMethodMap['requestTogglePlugin']['params']
    if (!request || typeof request.pluginName !== 'string' || request.pluginName.trim().length === 0) {
      throw new Error(`requestTogglePlugin requires a non-empty pluginName string. ${DOCS_HINT}`)
    }
    return getCommandPalette().requestPluginToggle(request.pluginName)
  })

  registry.register('requestUninstallPlugin', async (params) => {
    const request = params as WorkerHostMethodMap['requestUninstallPlugin']['params']
    if (!request || typeof request.pluginName !== 'string' || request.pluginName.trim().length === 0) {
      throw new Error(`requestUninstallPlugin requires a non-empty pluginName string. ${DOCS_HINT}`)
    }
    return getCommandPalette().requestPluginUninstall(request.pluginName)
  })

  registry.register('pickFromPalette', async (params) => {
    return getCommandPalette().pickFromPalette(params as WorkerHostMethodMap['pickFromPalette']['params'])
  })
}
