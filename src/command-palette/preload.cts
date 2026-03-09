import { contextBridge, ipcRenderer } from 'electron';

type SettingType = 'string' | 'number' | 'boolean'

type CommandPaletteAction =
  | {
    type: 'open-view'
    viewId: string
    title: string
    viewUpdatedAt: number | null
  }
  | {
    type: 'toggle-agent-chat'
  }
  | {
    type: 'close-current-tab'
  }
  | {
    type: 'reload-views'
  }
  | {
    type: 'enter-settings'
  }
  | {
    type: 'open-settings-file'
  }
  | {
    type: 'edit-setting'
    settingKey: string
    settingLabel: string
  };

interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group: 'Views' | 'Actions' | 'Tasks' | 'Settings'
  action: CommandPaletteAction
  settingValue?: string
  settingType?: SettingType
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
  listSettings(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS);
  },
  updateSetting(key: string, value: unknown): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, key, value);
  },
  openSettingsFile(): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE);
  },
  onSettingChanged(callback: (detail: { key: string; value: unknown }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, detail: { key: string; value: unknown }) => callback(detail);
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
  },
});
