import { contextBridge, ipcRenderer } from 'electron';

type CommandPaletteAction = { type: string; [key: string]: unknown }

interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group: string
  action: CommandPaletteAction
  settingValue?: string
  settingSource?: string
}

const COMMAND_PALETTE_CHANNEL = {
  CLOSE: 'app:command-palette:close',
  LIST_ITEMS: 'app:command-palette:list-items',
  RUN_ACTION: 'app:command-palette:run-action',
  OPENED: 'app:command-palette:opened',
  LIST_SETTINGS: 'app:command-palette:list-settings',
  UPDATE_SETTING: 'app:command-palette:update-setting',
  OPEN_SETTINGS_FILE: 'app:command-palette:open-settings-file',
  SETTING_CHANGED: 'app:command-palette:setting-changed',
  SHOW_FILTERED: 'app:command-palette:show-filtered',
  OPENED_WITH_FILTER: 'app:command-palette:opened-with-filter',
  LIST_BACKUPS: 'app:command-palette:list-backups',
  OPENED_AT_SCREEN: 'app:command-palette:opened-at-screen',
  CLEAR_TO_DEFAULT: 'app:command-palette:clear-to-default',
  LIST_TASKS: 'app:command-palette:list-tasks',
  LIST_SESSIONS: 'app:command-palette:list-sessions',
  RESIZE: 'app:command-palette:resize',
} as const;

contextBridge.exposeInMainWorld('commandPaletteBridge', {
  listItems(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_ITEMS);
  },
  runAction(action: CommandPaletteAction): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.RUN_ACTION, action);
  },
  close(): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.CLOSE);
  },
  onOpened(callback: () => void): () => void {
    const handler = () => callback();
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.OPENED, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.OPENED, handler);
  },
  onOpenedWithFilter(callback: (query: string) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, query: string) => callback(query);
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.OPENED_WITH_FILTER, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.OPENED_WITH_FILTER, handler);
  },
  onOpenedAtScreen(callback: (options: { screen: string; params?: Record<string, unknown> }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, options: { screen: string; params?: Record<string, unknown> }) => callback(options);
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, handler);
  },
  listSettings(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS);
  },
  updateSetting(key: string, value: unknown, scope?: 'agent' | 'global'): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, key, value, scope);
  },
  clearToDefault(key: string): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.CLEAR_TO_DEFAULT, key);
  },
  openSettingsFile(): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE);
  },
  listBackups(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_BACKUPS);
  },
  listTasks(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_TASKS);
  },
  listSessions(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_SESSIONS);
  },
  resize(size: { width?: number; height?: number }): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.RESIZE, size);
  },
  onSettingChanged(callback: (detail: { key: string; value: unknown }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, detail: { key: string; value: unknown }) => callback(detail);
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
  },
});
