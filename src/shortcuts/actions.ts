export interface ShortcutAction {
  label: string;
  defaultKey: string;
}

export const SHORTCUT_ACTIONS: Record<string, ShortcutAction> = {
  'toggle-command-palette': { label: 'Command Palette',   defaultKey: 'mod+k' },
  'toggle-agent-chat':     { label: 'Toggle AI Panel',    defaultKey: 'mod+i' },
  'toggle-task-panel':     { label: 'Toggle Task Panel',  defaultKey: 'mod+j' },
  'close-current-tab':     { label: 'Close Current Tab',  defaultKey: 'mod+w' },
  'reload-current-tab':    { label: 'Reload Current Tab', defaultKey: 'mod+r' },
  'reload-window':         { label: 'Reload Window',      defaultKey: 'mod+shift+r' },
  'open-agent':            { label: 'Open Agent',         defaultKey: 'mod+o' },
};

export const SHORTCUT_CONFIG_PREFIX = 'system.shortcuts.';
