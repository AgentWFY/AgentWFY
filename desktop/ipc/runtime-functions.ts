import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { AgentBackend } from '#shared/backend/interface.js'
import { Channels } from './channels.cjs'

export function registerRuntimeFunctionHandlers(
  getBackend: (e: IpcMainEvent | IpcMainInvokeEvent) => AgentBackend,
): void {
  ipcMain.handle(Channels.runtimeFunctions.call, async (event, methodName: string, params: unknown) => {
    if (typeof methodName !== 'string' || methodName.trim().length === 0) {
      throw new Error('runtime-functions:call requires a non-empty method name')
    }
    return getBackend(event).functions.invoke({ name: methodName, params })
  })

  // Sync IPC for method-name listing — the agentview preload must build
  // `window.agentwfy` before any view JS runs, so it can't await an RPC.
  ipcMain.on(Channels.runtimeFunctions.methods, (event) => {
    try {
      event.returnValue = getBackend(event).functions.getNamesSync()
    } catch {
      event.returnValue = []
    }
  })
}
