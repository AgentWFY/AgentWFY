import { ipcMain } from 'electron';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './manager';

export function registerCommandPaletteHandlers(commandPalette: CommandPaletteManager): void {
  ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLOSE, async () => {
    commandPalette.hide({ focusMain: true });
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_ITEMS, async () => {
    return commandPalette.buildItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.RUN_ACTION, async (_event, payload: unknown) => {
    await commandPalette.runAction(payload);
  });
}
