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
  }
  | {
    type: 'open-agent'
  }
  | {
    type: 'install-agent'
  }
  | {
    type: 'switch-agent'
    agentPath: string
  }
  | {
    type: 'backup-agent-db'
  }
  | {
    type: 'restore-agent-db'
  }
  | {
    type: 'restore-agent-db-confirm'
    backupVersion: number
  };

interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group: 'Views' | 'Actions' | 'Tasks' | 'Settings' | 'Agent' | 'Recent Agents' | 'Backup'
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
  SHOW_FILTERED: 'app:command-palette:show-filtered',
  OPENED_WITH_FILTER: 'app:command-palette:opened-with-filter',
  LIST_BACKUPS: 'app:command-palette:list-backups',
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
  listSettings(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_SETTINGS);
  },
  updateSetting(key: string, value: unknown): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.UPDATE_SETTING, key, value);
  },
  openSettingsFile(): Promise<void> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.OPEN_SETTINGS_FILE);
  },
  listBackups(): Promise<CommandPaletteItem[]> {
    return ipcRenderer.invoke(COMMAND_PALETTE_CHANNEL.LIST_BACKUPS);
  },
  onSettingChanged(callback: (detail: { key: string; value: unknown }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, detail: { key: string; value: unknown }) => callback(detail);
    ipcRenderer.on(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
    return () => ipcRenderer.removeListener(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, handler);
  },
});
