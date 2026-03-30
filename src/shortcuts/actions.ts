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
  'add-agent':             { label: 'Add Agent',          defaultKey: 'mod+o' },
  'toggle-zen-mode':       { label: 'Zen Mode',           defaultKey: 'mod+.' },
  'new-session':           { label: 'New Session',        defaultKey: 'mod+t' },
  'switch-to-tab-1':       { label: 'Switch to Tab 1',    defaultKey: 'mod+1' },
  'switch-to-tab-2':       { label: 'Switch to Tab 2',    defaultKey: 'mod+2' },
  'switch-to-tab-3':       { label: 'Switch to Tab 3',    defaultKey: 'mod+3' },
  'switch-to-tab-4':       { label: 'Switch to Tab 4',    defaultKey: 'mod+4' },
  'switch-to-tab-5':       { label: 'Switch to Tab 5',    defaultKey: 'mod+5' },
  'switch-to-tab-6':       { label: 'Switch to Tab 6',    defaultKey: 'mod+6' },
  'switch-to-tab-7':       { label: 'Switch to Tab 7',    defaultKey: 'mod+7' },
  'switch-to-tab-8':       { label: 'Switch to Tab 8',    defaultKey: 'mod+8' },
  'switch-to-tab-9':       { label: 'Switch to Tab 9',    defaultKey: 'mod+9' },
  'previous-tab':          { label: 'Previous Tab',       defaultKey: 'mod+shift+[' },
  'next-tab':              { label: 'Next Tab',           defaultKey: 'mod+shift+]' },
  'next-agent':            { label: 'Next Agent',         defaultKey: 'ctrl+tab' },
  'previous-agent':        { label: 'Previous Agent',     defaultKey: 'ctrl+shift+tab' },
  'search-views':          { label: 'Search Views',       defaultKey: 'mod+p' },
  'open-settings':         { label: 'Open Settings',      defaultKey: 'mod+,' },
};

export const SHORTCUT_CONFIG_PREFIX = 'system.shortcuts.';
