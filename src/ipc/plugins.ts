import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import { handleProviderFallback } from '../plugins/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { installFromPackage, uninstallPlugin } from '../plugins/installer.js'
import { getOrCreateAgentDb } from '../db/agent-db.js'
import { Channels } from './channels.js'

export function registerPluginHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getFunctionRegistry: (e: IpcMainInvokeEvent) => FunctionRegistry,
  getPluginRegistry: (e: IpcMainInvokeEvent) => PluginRegistry | null,
): void {
  ipcMain.handle(Channels.plugins.call, async (event, methodName: string, params: unknown) => {
    if (typeof methodName !== 'string' || methodName.trim().length === 0) {
      throw new Error('plugin:call requires a non-empty method name')
    }

    const registry = getFunctionRegistry(event)
    try {
      return await registry.call(methodName, params)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })

  // Async handler for renderer invoke()
  ipcMain.handle(Channels.plugins.methods, (event) => {
    const registry = getFunctionRegistry(event)
    return registry.getPluginMethodNames()
  })

  // Sync handler for agentview preload sendSync()
  ipcMain.on(Channels.plugins.methods, (event) => {
    const registry = getFunctionRegistry(event as unknown as IpcMainInvokeEvent)
    event.returnValue = registry.getPluginMethodNames()
  })

  ipcMain.handle(Channels.plugins.install, (event, packagePath: string) => {
    if (typeof packagePath !== 'string' || packagePath.trim().length === 0) {
      throw new Error('plugin:install requires a non-empty package path')
    }
    const agentRoot = getRoot(event)
    const result = installFromPackage(agentRoot, packagePath)

    // Activate installed plugins at runtime
    const pluginRegistry = getPluginRegistry(event)
    if (pluginRegistry && result.installed.length > 0) {
      const db = getOrCreateAgentDb(agentRoot)
      for (const name of result.installed) {
        const row = db.getPlugin(name)
        if (row) pluginRegistry.loadPlugin(row)
      }
    }

    return result
  })

  ipcMain.handle(Channels.plugins.uninstall, (event, pluginName: string) => {
    if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
      throw new Error('plugin:uninstall requires a non-empty plugin name')
    }
    const agentRoot = getRoot(event)

    // Deactivate plugin before removing from DB
    const pluginRegistry = getPluginRegistry(event)
    if (pluginRegistry) {
      const removedProviders = pluginRegistry.unloadPlugin(pluginName)
      handleProviderFallback(agentRoot, removedProviders)
    }

    uninstallPlugin(agentRoot, pluginName)
  })
}
