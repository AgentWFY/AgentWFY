export type CommandPaletteAction =
  | {
    type: 'open-view'
    viewName: string
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
    taskName: string
    taskTitle: string
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
    type: 'enter-add-agent'
  }
  | {
    type: 'add-default-agent'
  }
  | {
    type: 'add-agent-to-directory'
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
  | {
    type: 'new-session'
  }
  | {
    type: 'switch-agent'
    agentRoot: string
  }
  | {
    type: 'enter-agents'
  }
  | {
    type: 'open-tab'
    tabId: string
  }
  | {
    type: 'enter-tabs'
  }
  | {
    type: 'pick-item'
    index: number
  }

export interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  expandable?: boolean
  group: 'Views' | 'Actions' | 'Tasks' | 'Settings' | 'Backup' | 'Plugins' | 'System' | 'System Views' | 'Plugin Views' | 'Agents' | 'Sessions' | 'Tabs' | 'Pick'
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
  CLEAR_TO_DEFAULT: 'app:command-palette:clear-to-default',
  LIST_TASKS: 'app:command-palette:list-tasks',
  LIST_AGENTS: 'app:command-palette:list-agents',
  LIST_SESSIONS: 'app:command-palette:list-sessions',
  LIST_TABS: 'app:command-palette:list-tabs',
  RESIZE: 'app:command-palette:resize',
  LIST_PICK_ITEMS: 'app:command-palette:list-pick-items',
  RESOLVE_PICK: 'app:command-palette:resolve-pick',
} as const

export interface PickItemInput {
  title: string
  subtitle?: string
  value: unknown
}

export interface PickFromPaletteOptions {
  items: PickItemInput[]
  title?: string
  placeholder?: string
  timeoutMs?: number
}
