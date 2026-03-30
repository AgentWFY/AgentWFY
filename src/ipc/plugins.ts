import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { uninstallPlugin } from '../plugins/installer.js'
import type { CommandPaletteManager } from '../command-palette/manager.js'
import { Channels } from './channels.js'

export function registerPluginHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getFunctionRegistry: (e: IpcMainInvokeEvent) => FunctionRegistry,
  getPluginRegistry: (e: IpcMainInvokeEvent) => PluginRegistry | null,
  getCommandPalette: (e: IpcMainInvokeEvent) => CommandPaletteManager,
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
    try {
      const registry = getFunctionRegistry(event as unknown as IpcMainInvokeEvent)
      event.returnValue = registry.getPluginMethodNames()
    } catch {
      // Always set returnValue — if left unset, sendSync throws on the renderer
      // side, which can crash the preload and leave window.agentwfy undefined.
      event.returnValue = []
    }
  })

  ipcMain.handle(Channels.plugins.uninstall, (event, pluginName: string) => {
    if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
      throw new Error('plugin:uninstall requires a non-empty plugin name')
    }
    const agentRoot = getRoot(event)

    const pluginRegistry = getPluginRegistry(event)
    if (pluginRegistry) {
      pluginRegistry.unloadPlugin(pluginName)
    }

    uninstallPlugin(agentRoot, pluginName)
  })

  ipcMain.handle(Channels.plugins.requestInstall, async (event, packagePath: string) => {
    if (typeof packagePath !== 'string' || packagePath.trim().length === 0) {
      throw new Error('plugin:requestInstall requires a non-empty package path')
    }
    return getCommandPalette(event).requestPluginInstall(packagePath)
  })

  ipcMain.handle(Channels.plugins.requestToggle, async (event, pluginName: string) => {
    if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
      throw new Error('plugin:requestToggle requires a non-empty plugin name')
    }
    return getCommandPalette(event).requestPluginToggle(pluginName)
  })

  ipcMain.handle(Channels.plugins.requestUninstall, async (event, pluginName: string) => {
    if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
      throw new Error('plugin:requestUninstall requires a non-empty plugin name')
    }
    return getCommandPalette(event).requestPluginUninstall(pluginName)
  })
}
