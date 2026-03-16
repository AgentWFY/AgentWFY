import { BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { listViews } from '../db/views.js';
import { listTasks } from '../db/tasks.js';
import { ALL_SETTINGS, type SettingDefinition } from '../settings/registry.js';
import { storeSet } from '../ipc/store.js';
import { getConfigResolved, setAgentConfig, removeAgentConfig } from '../settings/config.js';
import {
  getRecentAgents,
  showOpenAgentDialog,
  showInstallAgentDialog,
  isAgentDir,
  shortenPath,
} from '../agent-manager.js';
import { backupAgentDb, listAllBackups, restoreFromBackup } from '../backup.js';
import type { RendererBridge } from '../renderer-bridge.js';
import type { TabViewManager } from '../tab-views/manager.js';
import { COMMAND_PALETTE_CHANNEL } from './types.js';
import type { CommandPaletteAction, CommandPaletteItem } from './types.js';

export { COMMAND_PALETTE_CHANNEL };

export interface CommandPaletteManagerDeps {
  getMainWindow: () => BrowserWindow | null;
  getAgentRoot: () => string;
  rendererBridge: RendererBridge;
  getTabViewManager: () => TabViewManager;
  getStorePath: () => string;
  registerSender?: (webContentsId: number) => void;
  unregisterSender?: (webContentsId: number) => void;
  openAgentInWindow: (agentRoot: string) => Promise<void>;
}

export class CommandPaletteManager {
  private commandPaletteWindow: BrowserWindow | null = null;
  private readonly deps: CommandPaletteManagerDeps;

  constructor(deps: CommandPaletteManagerDeps) {
    this.deps = deps;
  }

  getWindow(): BrowserWindow | null {
    return this.commandPaletteWindow;
  }

  private resolveCommandPaletteBounds(): Electron.Rectangle {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 720, height: 520 };
    }

    const bounds = mainWindow.getBounds();
    const width = Math.min(560, Math.max(420, Math.floor(bounds.width * 0.42)));
    const height = Math.min(380, Math.max(260, Math.floor(bounds.height * 0.38)));
    const x = bounds.x + Math.floor((bounds.width - width) / 2);
    const y = bounds.y + Math.max(40, Math.floor((bounds.height - height) * 0.15));
    return { x, y, width, height };
  }

  syncBounds(): void {
    if (!this.commandPaletteWindow || this.commandPaletteWindow.isDestroyed()) {
      return;
    }

    this.commandPaletteWindow.setBounds(this.resolveCommandPaletteBounds());
  }

  hide(options?: { focusMain?: boolean }): void {
    if (!this.commandPaletteWindow || this.commandPaletteWindow.isDestroyed() || !this.commandPaletteWindow.isVisible()) {
      return;
    }

    this.commandPaletteWindow.hide();
    if (options?.focusMain !== false) {
      this.deps.rendererBridge.focusMainRendererWindow();
    }
  }

  destroy(): void {
    if (!this.commandPaletteWindow || this.commandPaletteWindow.isDestroyed()) {
      this.commandPaletteWindow = null;
      return;
    }

    this.commandPaletteWindow.destroy();
    this.commandPaletteWindow = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.commandPaletteWindow && !this.commandPaletteWindow.isDestroyed()) {
      return this.commandPaletteWindow;
    }

    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable');
    }

    this.commandPaletteWindow = new BrowserWindow({
      parent: mainWindow,
      show: false,
      frame: false,
      transparent: false,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      roundedCorners: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f0f0f0',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'command-palette', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
        backgroundThrottling: false,
      },
    });

    if (process.platform === 'darwin') {
      this.commandPaletteWindow.setAlwaysOnTop(true, 'floating');
      this.commandPaletteWindow.setWindowButtonVisibility(false);
    }

    this.commandPaletteWindow.on('blur', () => {
      setTimeout(() => {
        if (!this.commandPaletteWindow || this.commandPaletteWindow.isDestroyed()) {
          return;
        }
        if (this.commandPaletteWindow.isFocused()) {
          return;
        }
        this.hide({ focusMain: true });
      }, 0);
    });

    const cpWebContentsId = this.commandPaletteWindow.webContents.id;
    this.commandPaletteWindow.on('closed', () => {
      this.deps.unregisterSender?.(cpWebContentsId);
      this.commandPaletteWindow = null;
    });

    this.deps.registerSender?.(cpWebContentsId);

    void this.commandPaletteWindow.loadURL(pathToFileURL(path.join(import.meta.dirname, 'command_palette.html')).toString())
      .catch((error) => {
        console.error('[command-palette] failed to load native command palette window', error);
      });

    return this.commandPaletteWindow;
  }

  private showAndNotify(channel: string, ...args: unknown[]): void {
    const paletteWindow = this.ensureWindow();
    this.syncBounds();
    paletteWindow.show();
    paletteWindow.moveTop();
    paletteWindow.focus();
    paletteWindow.webContents.focus();

    const focusSearchInput = () => {
      if (paletteWindow.isDestroyed()) return;
      void paletteWindow.webContents.executeJavaScript(`
        (() => {
          const input = document.getElementById('searchInput');
          if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
            return true;
          }
          return false;
        })();
      `, true).catch(() => {});
    };

    setTimeout(focusSearchInput, 0);
    setTimeout(focusSearchInput, 80);

    const notify = () => {
      if (!paletteWindow.isDestroyed()) {
        paletteWindow.webContents.send(channel, ...args);
      }
    };

    if (paletteWindow.webContents.isLoadingMainFrame()) {
      paletteWindow.webContents.once('did-finish-load', notify);
    } else {
      notify();
    }
  }

  show(options?: { screen?: string; params?: Record<string, unknown> }): void {
    if (options?.screen) {
      this.showAndNotify(COMMAND_PALETTE_CHANNEL.OPENED_AT_SCREEN, options);
    } else {
      this.showAndNotify(COMMAND_PALETTE_CHANNEL.OPENED);
    }
  }

  showFiltered(query: string): void {
    this.showAndNotify(COMMAND_PALETTE_CHANNEL.OPENED_WITH_FILTER, query);
  }

  toggle(): void {
    const paletteWindow = this.ensureWindow();
    if (paletteWindow.isVisible()) {
      this.hide({ focusMain: true });
      return;
    }

    this.show();
  }

  async buildItems(): Promise<CommandPaletteItem[]> {
    const agentRoot = this.deps.getAgentRoot();

    const rows = await listViews(agentRoot);

    const viewItems: CommandPaletteItem[] = rows.map((row) => ({
      id: `view:${row.id}`,
      title: row.name,
      group: 'Views',
      action: {
        type: 'open-view',
        viewId: String(row.id),
        title: row.name,
        viewUpdatedAt: row.updated_at ?? null,
      },
    }));

    const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
    const actionItems: CommandPaletteItem[] = [
      {
        id: 'action:toggle-agent-chat',
        title: 'Toggle AI Panel',
        shortcut: `${mod}I`,
        group: 'Actions',
        action: { type: 'toggle-agent-chat' },
      },
      {
        id: 'action:toggle-task-panel',
        title: 'Toggle Task Panel',
        shortcut: `${mod}J`,
        group: 'Actions',
        action: { type: 'toggle-task-panel' },
      },
      {
        id: 'action:close-current-tab',
        title: 'Close Current Tab',
        shortcut: `${mod}W`,
        group: 'Actions',
        action: { type: 'close-current-tab' },
      },
      {
        id: 'action:reload-current-tab',
        title: 'Reload Current Tab',
        shortcut: `${mod}R`,
        group: 'Actions',
        action: { type: 'reload-current-tab' },
      },
      {
        id: 'action:enter-settings',
        title: 'Settings...',
        group: 'Actions',
        action: { type: 'enter-settings' },
      },
      {
        id: 'action:open-settings-file',
        title: 'Open Settings File',
        group: 'Actions',
        action: { type: 'open-settings-file' },
      },
      {
        id: 'agent:open',
        title: 'Open Agent',
        group: 'Actions',
        action: { type: 'open-agent' },
      },
      {
        id: 'agent:install',
        title: 'Install Agent',
        group: 'Actions',
        action: { type: 'install-agent' },
      },
      {
        id: 'agent:recent-agents',
        title: 'Recent Agents...',
        group: 'Actions',
        action: { type: 'enter-recent-agents' },
      },
      {
        id: 'agent:backup-db',
        title: 'Backup Agent Database',
        group: 'Actions',
        action: { type: 'backup-agent-db' },
      },
      {
        id: 'agent:restore-db',
        title: 'Restore Agent Database...',
        group: 'Actions',
        action: { type: 'restore-agent-db' },
      },
      {
        id: 'action:run-task',
        title: 'Run Task...',
        group: 'Actions',
        action: { type: 'enter-tasks' },
      },
    ];

    return [...actionItems, ...viewItems];
  }

  buildSettingsItems(): CommandPaletteItem[] {
    const agentRoot = this.deps.getAgentRoot();
    return ALL_SETTINGS.map((def) => {
      const resolved = getConfigResolved(agentRoot, def.key);
      return {
        id: `setting:${def.key}`,
        title: def.label,
        subtitle: def.description,
        group: 'Settings' as const,
        settingValue: String(resolved.value),
        settingSource: resolved.source,
        settingType: def.type,
        action: {
          type: 'edit-setting' as const,
          settingKey: def.key,
          settingLabel: def.label,
        },
      };
    });
  }

  private coerceAndValidate(def: SettingDefinition, rawValue: unknown): { success: boolean; value?: unknown; error?: string } {
    let coerced: unknown = rawValue;
    if (def.type === 'number') {
      coerced = Number(rawValue);
      if (!isFinite(coerced as number)) {
        return { success: false, error: 'Must be a valid number' };
      }
    } else if (def.type === 'boolean') {
      coerced = rawValue === true || rawValue === 'true';
    }

    if (def.validate) {
      const error = def.validate(coerced);
      if (error) return { success: false, error };
    }

    return { success: true, value: coerced };
  }

  updateSetting(key: string, rawValue: unknown, scope?: 'agent' | 'global'): { success: boolean; error?: string } {
    const def = ALL_SETTINGS.find((s) => s.key === key);
    if (!def) return { success: false, error: 'Unknown setting' };

    const result = this.coerceAndValidate(def, rawValue);
    if (!result.success) return { success: false, error: result.error };

    if (scope === 'agent') {
      setAgentConfig(this.deps.getAgentRoot(), key, result.value);
    } else {
      storeSet(key, result.value);
    }
    return { success: true };
  }

  clearAgentOverride(key: string): void {
    removeAgentConfig(this.deps.getAgentRoot(), key);
  }

  buildRecentAgentItems(): CommandPaletteItem[] {
    const recents = getRecentAgents();
    return recents.map((recent) => ({
      id: `agent:recent:${recent.path}`,
      title: shortenPath(recent.path),
      subtitle: 'Switch agent',
      group: 'Recent Agents' as const,
      action: { type: 'switch-agent' as const, agentPath: recent.path },
    }));
  }

  async buildTaskItems(): Promise<CommandPaletteItem[]> {
    try {
      const tasks = await listTasks(this.deps.getAgentRoot());
      return tasks.map((task) => ({
        id: `task:${task.id}`,
        title: task.name,
        subtitle: task.description || undefined,
        group: 'Tasks' as const,
        action: {
          type: 'run-task' as const,
          taskId: task.id,
          taskName: task.name,
          taskDescription: task.description || undefined,
        },
      }));
    } catch (err) {
      console.error('[command-palette] listTasks failed:', err);
      return [];
    }
  }

  buildBackupItems(): CommandPaletteItem[] {
    const backups = listAllBackups(this.deps.getAgentRoot());
    return backups.map((b) => {
      const date = new Date(b.timestamp);
      const dateStr = date.toLocaleString();

      return {
        id: `backup:v${b.version}`,
        title: `v${b.version}`,
        subtitle: dateStr,
        group: 'Backup',
        settingValue: b.matchesCurrent ? 'current' : undefined,
        action: {
          type: 'restore-agent-db-confirm',
          backupVersion: b.version,
        },
      };
    });
  }

  openSettingsFile(): void {
    shell.openPath(this.deps.getStorePath());
  }

  async runAction(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Command palette action payload is required');
    }

    const action = payload as CommandPaletteAction;
    const type = typeof (action as { type?: unknown }).type === 'string'
      ? (action as { type: string }).type
      : '';
    if (!type) {
      throw new Error('Command palette action requires a type');
    }

    switch (type) {
      case 'open-view':
        this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:open-view', {
          viewId: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).viewId,
          title: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).title,
          viewUpdatedAt: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).viewUpdatedAt ?? null,
        });
        break;

      case 'toggle-agent-chat':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        break;

      case 'toggle-task-panel':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-task-panel');
        break;

      case 'close-current-tab':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:remove-current-tab');
        break;

      case 'reload-current-tab':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:refresh-current-view');
        break;

      case 'run-task': {
        const taskAction = action as Extract<CommandPaletteAction, { type: 'run-task' }>;
        this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:run-task', {
          taskId: taskAction.taskId,
          input: taskAction.input || undefined,
        });
        break;
      }

      case 'open-settings-file':
        this.openSettingsFile();
        break;

      case 'enter-settings':
      case 'enter-recent-agents':
      case 'enter-tasks':
        // Handled entirely in the palette UI
        return;

      case 'edit-setting':
        // Handled entirely in the palette UI
        return;

      case 'open-agent': {
        this.hide({ focusMain: true });
        const picked = await showOpenAgentDialog(this.deps.getMainWindow());
        if (picked) await this.deps.openAgentInWindow(picked);
        return;
      }

      case 'install-agent': {
        this.hide({ focusMain: true });
        const installed = await showInstallAgentDialog(this.deps.getMainWindow());
        if (installed) await this.deps.openAgentInWindow(installed);
        return;
      }

      case 'switch-agent': {
        const switchAction = action as Extract<CommandPaletteAction, { type: 'switch-agent' }>;
        this.hide({ focusMain: true });
        if (isAgentDir(switchAction.agentPath)) {
          await this.deps.openAgentInWindow(switchAction.agentPath);
        } else {
          const picked = await showOpenAgentDialog(this.deps.getMainWindow());
          if (picked) await this.deps.openAgentInWindow(picked);
        }
        return;
      }

      case 'backup-agent-db': {
        const result = await backupAgentDb(this.deps.getAgentRoot());
        if (result.error) {
          throw new Error(result.error);
        }
        this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:backup-changed', {
          version: result.version ?? null,
          skipped: result.skipped,
        });
        this.hide({ focusMain: true });
        return;
      }

      case 'restore-agent-db': {
        // Handled in the palette UI — switches to restore mode
        return;
      }

      case 'restore-agent-db-confirm': {
        const restoreAction = action as Extract<CommandPaletteAction, { type: 'restore-agent-db-confirm' }>;
        const result = await restoreFromBackup(this.deps.getAgentRoot(), restoreAction.backupVersion);
        if (!result.success) {
          throw new Error(result.error || 'Restore failed');
        }
        this.hide({ focusMain: true });
        // Reload the app to pick up restored DB — full reset like agent switch
        const mainWindow = this.deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          this.deps.getTabViewManager().destroyAllTabViews();
          this.deps.getTabViewManager().clearTrackedViewWebContents();
          mainWindow.reload();
        }
        return;
      }

      default:
        throw new Error(`Unsupported command palette action type: ${type}`);
    }

    this.hide({ focusMain: true });
  }
}
