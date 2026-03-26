import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './manager.js';

export function registerCommandPaletteHandlers(getCommandPalette: (e: IpcMainInvokeEvent) => CommandPaletteManager): void {
  ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLOSE, async (event) => {
    getCommandPalette(event).hide({ focusMain: true });
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_ITEMS, async (event) => {
    return getCommandPalette(event).buildItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.RUN_ACTION, async (event, payload: unknown) => {
    await getCommandPalette(event).runAction(payload);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS, async (event) => {
    return getCommandPalette(event).buildSettingsItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, async (event, key: string, value: unknown, scope?: 'agent' | 'global') => {
    return getCommandPalette(event).updateSetting(key, value, scope);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLEAR_AGENT_OVERRIDE, async (event, key: string) => {
    getCommandPalette(event).clearAgentOverride(key);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE, async (event) => {
    getCommandPalette(event).openSettingsFile();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.SHOW_FILTERED, async (event, query: string) => {
    getCommandPalette(event).showFiltered(query);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, async (event, options: { screen?: string; params?: Record<string, unknown> }) => {
    getCommandPalette(event).show(options);
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_BACKUPS, async (event) => {
    return getCommandPalette(event).buildBackupItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_RECENT_AGENTS, async (event) => {
    return getCommandPalette(event).buildRecentAgentItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_TASKS, async (event) => {
    return getCommandPalette(event).buildTaskItems();
  });

  ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_SESSIONS, async (event) => {
    return getCommandPalette(event).buildSessionItems();
  });

}
