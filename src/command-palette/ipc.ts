import { ipcMain } from 'electron';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './manager.js';

export function registerCommandPaletteHandlers(getCommandPalette: () => CommandPaletteManager): void {
  ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLOSE, async () => {
    getCommandPalette().hide({ focusMain: true });
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_ITEMS, async () => {
    return getCommandPalette().buildItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.RUN_ACTION, async (_event, payload: unknown) => {
    await getCommandPalette().runAction(payload);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS, async () => {
    return getCommandPalette().buildSettingsItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, async (_event, key: string, value: unknown, scope?: 'agent' | 'global') => {
    return getCommandPalette().updateSetting(key, value, scope);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLEAR_TO_DEFAULT, async (_event, key: string) => {
    getCommandPalette().clearToDefault(key);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE, async () => {
    getCommandPalette().openSettingsFile();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.SHOW_FILTERED, async (_event, query: string) => {
    getCommandPalette().showFiltered(query);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, async (_event, options: { screen?: string; params?: Record<string, unknown> }) => {
    getCommandPalette().show(options);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_BACKUPS, async () => {
    return getCommandPalette().buildBackupItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_TASKS, async () => {
    return getCommandPalette().buildTaskItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_AGENTS, async () => {
    return getCommandPalette().buildAgentItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_SESSIONS, async () => {
    return getCommandPalette().buildSessionItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_TABS, async () => {
    return getCommandPalette().buildTabItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.RESIZE, async (_event, size: { width?: number; height?: number }) => {
    getCommandPalette().resizeTo(size);
  });

}
