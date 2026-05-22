import { dialog, ipcMain } from 'electron'
import type { ConfirmationManager } from './manager.js'
import { CONFIRMATION_CHANNEL } from './types.js'

export function registerConfirmationHandlers(getManager: () => ConfirmationManager): void {
  ipcMain.handle(CONFIRMATION_CHANNEL.RESULT, async (_event, requestId: string, confirmed: boolean, data?: Record<string, unknown>) => {
    getManager().resolveConfirmation(requestId, confirmed, data)
  })

  ipcMain.handle(CONFIRMATION_CHANNEL.PICK_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Directory for Agent',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
