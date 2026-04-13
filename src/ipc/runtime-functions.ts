import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import { Channels } from './channels.cjs'

export function registerRuntimeFunctionHandlers(
  getFunctionRegistry: (e: IpcMainInvokeEvent) => FunctionRegistry,
): void {
  ipcMain.handle(Channels.runtimeFunctions.call, async (event, methodName: string, params: unknown) => {
    if (typeof methodName !== 'string' || methodName.trim().length === 0) {
      throw new Error('runtime-functions:call requires a non-empty method name')
    }
    const registry = getFunctionRegistry(event)
    return registry.call(methodName, params)
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
