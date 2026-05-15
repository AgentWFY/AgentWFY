import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AgentBackend } from '#shared/backend/interface.js'
import type { FunctionRegistry } from '#shared/runtime/function_registry.js'
import { Channels } from './channels.cjs'

export function registerRuntimeFunctionHandlers(
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
  // Sync IPC for method-name listing — must return synchronously, so it
  // sidesteps the async backend.functions.list() and reads the underlying
  // registry directly. Both paths return the same data.
  getFunctionRegistry: (e: IpcMainInvokeEvent) => FunctionRegistry,
): void {
  ipcMain.handle(Channels.runtimeFunctions.call, async (event, methodName: string, params: unknown) => {
    if (typeof methodName !== 'string' || methodName.trim().length === 0) {
      throw new Error('runtime-functions:call requires a non-empty method name')
    }
    const registry = getFunctionRegistry(event)
    if (registry.has(methodName)) {
      return registry.call(methodName, params)
    }
    return getBackend(event).functions.invoke({ name: methodName, params })
  })

  ipcMain.on(Channels.runtimeFunctions.methods, (event) => {
    try {
      const registry = getFunctionRegistry(event as unknown as IpcMainInvokeEvent)
      event.returnValue = registry.getMethodNames()
    } catch {
      event.returnValue = []
    }
  })
}
