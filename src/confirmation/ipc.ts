import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ConfirmationManager } from './manager.js'
import { CONFIRMATION_CHANNEL } from './types.js'

export function registerConfirmationHandlers(getManager: (e: IpcMainInvokeEvent) => ConfirmationManager): void {
  ipcMain.handle(CONFIRMATION_CHANNEL.RESULT, async (event, requestId: string, confirmed: boolean) => {
    getManager(event).resolveConfirmation(requestId, confirmed)
  })
}
