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
    type: 'toggle-task-panel'
  }
  | {
    type: 'close-current-tab'
  }
  | {
    type: 'reload-current-tab'
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
    type: 'add-agent'
  }
  | {
    type: 'import-agent-from-file'
  }
  | {
    type: 'backup-agent-db'
  }
  | {
    type: 'restore-agent-db'
  }
  | {
    type: 'enter-tasks'
  }
  | {
    type: 'install-plugin'
  }
  | {
    type: 'restore-agent-db-confirm'
    backupVersion: number
  }
  | {
    type: 'enter-sessions'
  }
  | {
    type: 'load-session'
    file: string
    label: string
  }
  | {
    type: 'toggle-zen-mode'
  }

export interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  expandable?: boolean
  group: 'Views' | 'Actions' | 'Tasks' | 'Settings' | 'Scope' | 'Backup' | 'Plugins' | 'System' | 'System Views' | 'Plugin Views' | 'Sessions'
  action: CommandPaletteAction
  settingValue?: string
  settingSource?: string
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
  CLEAR_AGENT_OVERRIDE: 'app:command-palette:clear-agent-override',
  LIST_TASKS: 'app:command-palette:list-tasks',
  LIST_SESSIONS: 'app:command-palette:list-sessions',
  RESIZE: 'app:command-palette:resize',
} as const
