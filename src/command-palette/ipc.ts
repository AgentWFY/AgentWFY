import { ipcMain } from 'electron';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './manager.js';

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

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS, async () => {
    return commandPalette.buildSettingsItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, async (_event, key: string, value: unknown) => {
    return commandPalette.updateSetting(key, value);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE, async () => {
    commandPalette.openSettingsFile();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.SHOW_FILTERED, async (_event, query: string) => {
    commandPalette.showFiltered(query);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, async (_event, options: { screen?: string; params?: Record<string, unknown> }) => {
    commandPalette.show(options);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_BACKUPS, async () => {
    return commandPalette.buildBackupItems();
  });
}
