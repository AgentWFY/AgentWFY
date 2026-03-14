export type SettingType = 'string' | 'number' | 'boolean'

export type CommandPaletteAction =
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
    type: 'run-task'
    taskId: number
    taskName: string
    taskDescription?: string
    input?: string
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
  }
  | {
    type: 'sync-system-prompt'
  }

export interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group: 'Views' | 'Actions' | 'Tasks' | 'Settings' | 'Agent' | 'Recent Agents' | 'Backup'
  action: CommandPaletteAction
  settingValue?: string
  settingType?: SettingType
}

export const COMMAND_PALETTE_CHANNEL = {
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
} as const
