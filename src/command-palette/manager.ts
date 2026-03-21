import { BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { listViews } from '../db/views.js';
import { listTasks } from '../db/tasks.js';
import { listConfig } from '../db/config.js';
import { getOrCreateAgentDb } from '../db/agent-db.js';
import { installFromPackage, uninstallPlugin, readPackageMetadata } from '../plugins/installer.js';
import { storeSet } from '../ipc/store.js';
import { setAgentConfig, clearAgentConfig, removeAgentConfig } from '../settings/config.js';
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
import { handleProviderFallback } from '../plugins/registry.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ConfirmationManager } from '../confirmation/manager.js';
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
  getPluginRegistry: () => PluginRegistry | null;
  getConfirmation: () => ConfirmationManager;
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
        webSecurity: true,
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

    const viewItems: CommandPaletteItem[] = rows.map((row) => {
      const displayTitle = row.title || row.name;
      let group: CommandPaletteItem['group'];
      if (row.name.startsWith('system.')) {
        group = 'System Views';
      } else if (row.name.startsWith('plugin.')) {
        group = 'Plugin Views';
      } else {
        group = 'Views';
      }
      return {
        id: `view:${row.id}`,
        title: displayTitle,
        group,
        action: {
          type: 'open-view',
          viewId: String(row.id),
          title: displayTitle,
          viewUpdatedAt: row.updated_at ?? null,
        },
      };
    });

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
        title: 'Settings',
        expandable: true,
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
        title: 'Recent Agents',
        expandable: true,
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
        title: 'Restore Agent Database',
        expandable: true,
        group: 'Actions',
        action: { type: 'restore-agent-db' },
      },
      {
        id: 'action:run-task',
        title: 'Run Task',
        expandable: true,
        group: 'Actions',
        action: { type: 'enter-tasks' },
      },
      {
        id: 'action:install-plugin',
        title: 'Install Plugin',
        group: 'Actions',
        action: { type: 'install-plugin' },
      },
    ];

    return [...actionItems, ...viewItems];
  }

  async buildSettingsItems(): Promise<CommandPaletteItem[]> {
    const agentRoot = this.deps.getAgentRoot();
    const rows = await listConfig(agentRoot);
    return rows.map((row) => {
      let group: CommandPaletteItem['group'];
      if (row.name.startsWith('system.')) group = 'System';
      else if (row.name.startsWith('plugin.')) group = 'Plugins';
      else group = 'Settings';
      return {
        id: `setting:${row.name}`,
        title: row.name,
        subtitle: row.description,
        group,
        settingValue: row.value ?? '',
        action: {
          type: 'edit-setting' as const,
          settingKey: row.name,
          settingLabel: row.name,
        },
      };
    });
  }

  updateSetting(name: string, rawValue: unknown, scope?: 'agent' | 'global'): { success: boolean; error?: string } {
    if (scope === 'agent') {
      setAgentConfig(this.deps.getAgentRoot(), name, rawValue);
    } else {
      storeSet(name, rawValue);
    }
    return { success: true };
  }

  clearAgentOverride(name: string): void {
    // system.* and plugin.* rows can't be deleted — set value to NULL instead
    if (name.startsWith('system.') || name.startsWith('plugin.')) {
      clearAgentConfig(this.deps.getAgentRoot(), name);
    } else {
      removeAgentConfig(this.deps.getAgentRoot(), name);
    }
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

  performInstall(packagePath: string): { installed: string[] } {
    const agentRoot = this.deps.getAgentRoot();
    const installResult = installFromPackage(agentRoot, packagePath);

    // Activate installed plugins at runtime
    const pluginRegistry = this.deps.getPluginRegistry();
    if (pluginRegistry && installResult.installed.length > 0) {
      const db = getOrCreateAgentDb(agentRoot);
      for (const name of installResult.installed) {
        const row = db.getPlugin(name);
        if (row) pluginRegistry.loadPlugin(row);
      }
    }

    if (installResult.installed.length > 0) {
      const names = installResult.installed.join(', ');
      this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:plugin-changed', {
        message: `Installed ${names}`,
      });
    }
    return installResult;
  }

  async installPluginFromDialog(): Promise<{ installed: string[] }> {
    const mainWindow = this.deps.getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Install Plugin',
      filters: [{ name: 'Plugin Package', extensions: ['plugins.awfy'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { installed: [] };
    }

    return this.requestPluginInstall(result.filePaths[0]);
  }

  uninstallPluginByName(pluginName: string): void {
    const agentRoot = this.deps.getAgentRoot();

    // Deactivate plugin before removing from DB
    const pluginRegistry = this.deps.getPluginRegistry();
    if (pluginRegistry) {
      const removedProviders = pluginRegistry.unloadPlugin(pluginName);
      handleProviderFallback(agentRoot, removedProviders);
    }

    uninstallPlugin(agentRoot, pluginName);
    this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:plugin-changed', {
      message: `Uninstalled ${pluginName}`,
    });
  }

  togglePluginEnabled(pluginName: string, enabled: boolean): void {
    const agentRoot = this.deps.getAgentRoot();
    const db = getOrCreateAgentDb(agentRoot);
    db.togglePlugin(pluginName, enabled);

    const pluginRegistry = this.deps.getPluginRegistry();
    if (pluginRegistry) {
      if (!enabled) {
        const removedProviders = pluginRegistry.unloadPlugin(pluginName);
        handleProviderFallback(agentRoot, removedProviders);
      } else {
        const row = db.getPlugin(pluginName);
        if (row) pluginRegistry.loadPlugin(row);
      }
    }

    this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:plugin-changed', {
      message: `${enabled ? 'Enabled' : 'Disabled'} ${pluginName}`,
    });
  }

  async requestPluginInstall(packagePath: string): Promise<{ installed: string[] }> {
    const metadata = readPackageMetadata(packagePath);
    const confirmation = this.deps.getConfirmation();
    const confirmed = await confirmation.requestConfirmation('confirm-plugin-install', {
      packagePath,
      plugins: metadata.plugins,
    });
    if (!confirmed) {
      return { installed: [] };
    }
    return this.performInstall(packagePath);
  }

  async requestPluginToggle(pluginName: string): Promise<{ toggled: boolean; enabled?: boolean }> {
    const db = getOrCreateAgentDb(this.deps.getAgentRoot());
    const plugin = db.getPluginInfo(pluginName);
    if (!plugin) {
      throw new Error(`Plugin '${pluginName}' not found`);
    }
    const currentEnabled = !!plugin.enabled;
    const confirmation = this.deps.getConfirmation();
    const confirmed = await confirmation.requestConfirmation('confirm-plugin-toggle', {
      pluginName,
      currentEnabled,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    });
    if (!confirmed) {
      return { toggled: false };
    }
    this.togglePluginEnabled(pluginName, !currentEnabled);
    return { toggled: true, enabled: !currentEnabled };
  }

  async requestPluginUninstall(pluginName: string): Promise<{ uninstalled: boolean }> {
    const db = getOrCreateAgentDb(this.deps.getAgentRoot());
    const plugin = db.getPluginInfo(pluginName);
    if (!plugin) {
      throw new Error(`Plugin '${pluginName}' not found`);
    }
    const confirmation = this.deps.getConfirmation();
    const confirmed = await confirmation.requestConfirmation('confirm-plugin-uninstall', {
      pluginName,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    });
    if (!confirmed) {
      return { uninstalled: false };
    }
    this.uninstallPluginByName(pluginName);
    return { uninstalled: true };
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
      case 'open-view': {
        const openViewAction = action as Extract<CommandPaletteAction, { type: 'open-view' }>;
        await this.deps.getTabViewManager().openTabHandler({
          viewId: openViewAction.viewId,
          title: openViewAction.title,
        });
        break;
      }

      case 'toggle-agent-chat':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        break;

      case 'toggle-task-panel':
        this.deps.rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-task-panel');
        break;

      case 'close-current-tab':
        this.deps.getTabViewManager().closeCurrentTab();
        break;

      case 'reload-current-tab':
        this.deps.getTabViewManager().reloadCurrentTab();
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

      case 'install-plugin': {
        this.hide({ focusMain: true });
        await this.installPluginFromDialog();
        return;
      }

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
