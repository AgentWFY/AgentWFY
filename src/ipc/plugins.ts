import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import { installFromPackage, uninstallPlugin } from '../plugins/installer.js'
import { Channels } from './channels.js'

export function registerPluginHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getFunctionRegistry: (e: IpcMainInvokeEvent) => FunctionRegistry,
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
    return installFromPackage(agentRoot, packagePath)
  })

  ipcMain.handle(Channels.plugins.uninstall, (event, pluginName: string) => {
    if (typeof pluginName !== 'string' || pluginName.trim().length === 0) {
      throw new Error('plugin:uninstall requires a non-empty plugin name')
    }
    const agentRoot = getRoot(event)
    uninstallPlugin(agentRoot, pluginName)
  })
}
