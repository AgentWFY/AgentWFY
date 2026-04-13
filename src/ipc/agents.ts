import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'path'
import type { CommandPaletteManager } from '../command-palette/manager.js'
import { Channels } from './channels.cjs'

export function registerAgentHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getCommandPalette: () => CommandPaletteManager,
): void {
  ipcMain.handle(Channels.agents.requestInstall, async (event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('agents:requestInstall requires a non-empty file path')
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(getRoot(event), filePath)
    return getCommandPalette().requestAgentInstall(resolved)
  })
}
