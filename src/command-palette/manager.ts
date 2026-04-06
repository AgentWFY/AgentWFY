import { BaseWindow, WebContentsView, dialog, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { listViews, getViewByName } from '../db/views.js';
import { listTasks } from '../db/tasks.js';
import { listConfig } from '../db/config.js';
import { getOrCreateAgentDb } from '../db/agent-db.js';
import { installPackageData, uninstallPlugin, readValidatedPackage } from '../plugins/installer.js';
import { storeRemove } from '../ipc/store.js';
import { setAgentConfig, clearAgentConfig, removeAgentConfig, getGlobalValue } from '../settings/config.js';
import { globalConfigSet, globalConfigRemove, getGlobalConfigPath, ensureGlobalConfig } from '../settings/global-config.js';
import {
  showOpenAgentDialog,
  showInstallAgentFromFileDialog,
  initAgent,
} from '../agent-manager.js';
import { backupAgentDb, listAllBackups, restoreFromBackup } from '../backup.js';
import type { RendererBridge } from '../renderer-bridge.js';
import type { TabViewManager } from '../tab-views/manager.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { ConfirmationManager } from '../confirmation/manager.js';
import type { AgentSessionManager } from '../agent/session_manager.js';
import { COMMAND_PALETTE_CHANNEL } from './types.js';
import type { CommandPaletteAction, CommandPaletteItem } from './types.js';

export { COMMAND_PALETTE_CHANNEL };

export interface CommandPaletteManagerDeps {
  getMainWindow: () => BaseWindow | null;
  getAgentRoot: () => string;
  rendererBridge: RendererBridge;
  getTabViewManager: () => TabViewManager;
  addAgent: (agentRoot: string) => Promise<void>;
  getPluginRegistry: () => PluginRegistry | null;
  getConfirmation: () => ConfirmationManager;
  getSessionManager: () => AgentSessionManager;
  getDisplayShortcut: (actionId: string) => string | null;
  matchShortcut: (key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) => string | null;
  handleShortcutAction: (action: string) => void;
  reloadRenderer: () => void;
}

/** Extra padding around the palette content for the CSS drop-shadow to render. */
const VIEW_PADDING = 40;

export class CommandPaletteManager {
  private view: WebContentsView | null = null;
  private readonly deps: CommandPaletteManagerDeps;

  constructor(deps: CommandPaletteManagerDeps) {
    this.deps = deps;
  }

  getWebContents(): Electron.WebContents | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null;
    return this.view.webContents;
  }

  isVisible(): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && this.view.getVisible();
  }

  private resolveContentBounds(): Electron.Rectangle {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 720, height: 520 };
    }

    const [cw, ch] = mainWindow.getContentSize();
    const width = Math.min(560, Math.max(420, Math.floor(cw * 0.42)));
    const height = Math.min(380, Math.max(260, Math.floor(ch * 0.38)));
    const x = Math.floor((cw - width) / 2);
    const y = Math.max(40, Math.floor(ch * 0.15));
    return { x, y, width, height };
  }

  private applyBounds(contentBounds: Electron.Rectangle): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.setBounds({
      x: contentBounds.x - VIEW_PADDING,
      y: contentBounds.y - VIEW_PADDING,
      width: contentBounds.width + VIEW_PADDING * 2,
      height: contentBounds.height + VIEW_PADDING * 2,
    });
  }

  resizeTo(size: { width?: number; height?: number }): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;

    // width=0 or height=0 means reset to default palette bounds
    if (!size.width || !size.height) {
      this.syncBounds();
      return;
    }

    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const [cw, ch] = mainWindow.getContentSize();
    const width = Math.min(size.width, cw - 40);
    const height = Math.min(size.height, ch - 80);
    const x = Math.floor((cw - width) / 2);
    const y = Math.max(40, Math.floor(ch * 0.12));

    this.applyBounds({ x, y, width, height });
  }

  syncBounds(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.applyBounds(this.resolveContentBounds());
  }

  hide(options?: { focusMain?: boolean }): void {
    if (!this.view || this.view.webContents.isDestroyed() || !this.view.getVisible()) {
      return;
    }

    this.view.setVisible(false);
    if (options?.focusMain !== false) {
      this.deps.rendererBridge.focusMainRendererWindow();
    }
  }

  destroy(): void {
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.view = null;
      return;
    }

    const mainWindow = this.deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(this.view); } catch {}
    }

    this.view.webContents.close();
    this.view = null;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }

    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable');
    }

    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    this.view.setBackgroundColor('#00000000');

    // Handle keyboard shortcuts when the palette has focus (e.g. Cmd+K to toggle off)
    // Skip Ctrl+J/K/N/P — those are palette navigation keys handled by the UI
    this.view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (!key || input.isAutoRepeat) return;

      if (input.control && !input.meta && 'jknp'.includes(key)) return;

      const action = this.deps.matchShortcut(key, !!input.meta, !!input.control, !!input.shift, !!input.alt);
      if (!action) return;

      event.preventDefault();
      this.deps.handleShortcutAction(action);
    });

    this.view.setVisible(false);
    mainWindow.contentView.addChildView(this.view);
    this.applyBounds(this.resolveContentBounds());

    void this.view.webContents.loadURL(pathToFileURL(path.join(import.meta.dirname, '..', 'command_palette.html')).toString())
      .catch((error) => {
        console.error('[command-palette] failed to load native command palette window', error);
      });

    return this.view;
  }

  private showAndNotify(channel: string, ...args: unknown[]): void {
    const view = this.ensureView();
    this.syncBounds();

    // Bring view to top of z-order
    const mainWindow = this.deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(view); } catch {}
      mainWindow.contentView.addChildView(view);
    }

    if (!process.env.AGENTWFY_HEADLESS) {
      view.setVisible(true);
    }
    view.webContents.focus();

    const focusSearchInput = () => {
      if (view.webContents.isDestroyed()) return;
      void view.webContents.executeJavaScript(`
        document.getElementById('searchInput')?.focus();
      `, true).catch(() => {});
    };

    setTimeout(focusSearchInput, 0);
    setTimeout(focusSearchInput, 80);

    const notify = () => {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send(channel, ...args);
      }
    };

    if (view.webContents.isLoadingMainFrame()) {
      view.webContents.once('did-finish-load', notify);
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
    this.ensureView();
    if (this.isVisible()) {
      this.hide({ focusMain: true });
      return;
    }

    this.show();
  }

  async buildItems(): Promise<CommandPaletteItem[]> {
    const agentRoot = this.deps.getAgentRoot();

    const rows = await listViews(agentRoot);

    const viewItems: CommandPaletteItem[] = rows.map((row) => {
      const viewTitle = row.title || row.name;
      let displayTitle = viewTitle;
      let group: CommandPaletteItem['group'];
      if (row.name.startsWith('system.')) {
        group = 'System Views';
      } else if (row.name.startsWith('plugin.')) {
        group = 'Plugin Views';
        const pluginName = row.name.split('.')[1];
        if (pluginName) {
          displayTitle = `${pluginName}: ${viewTitle}`;
        }
      } else {
        group = 'Views';
      }
      return {
        id: `view:${row.name}`,
        title: displayTitle,
        group,
        action: {
          type: 'open-view',
          viewName: row.name,
          title: viewTitle,
          viewUpdatedAt: row.updated_at ?? null,
        },
      };
    });

    const ds = (id: string) => this.deps.getDisplayShortcut(id) ?? undefined;
    const actionItems: CommandPaletteItem[] = [
      {
        id: 'action:toggle-agent-chat',
        title: 'Toggle AI Panel',
        shortcut: ds('toggle-agent-chat'),
        group: 'Actions',
        action: { type: 'toggle-agent-chat' },
      },
      {
        id: 'action:toggle-task-panel',
        title: 'Toggle Task Panel',
        shortcut: ds('toggle-task-panel'),
        group: 'Actions',
        action: { type: 'toggle-task-panel' },
      },
      {
        id: 'action:toggle-zen-mode',
        title: 'Zen Mode',
        shortcut: ds('toggle-zen-mode'),
        group: 'Actions',
        action: { type: 'toggle-zen-mode' },
      },
      {
        id: 'action:new-session',
        title: 'New Session',
        shortcut: ds('new-session'),
        group: 'Actions',
        action: { type: 'new-session' },
      },
      {
        id: 'action:enter-settings',
        title: 'Settings',
        shortcut: ds('open-settings'),
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
        id: 'agent:add',
        title: 'Add Agent',
        group: 'Actions',
        action: { type: 'add-agent' },
      },
      {
        id: 'agent:import-from-file',
        title: 'Import Agent from File',
        group: 'Actions',
        action: { type: 'import-agent-from-file' },
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
      {
        id: 'action:enter-sessions',
        title: 'Sessions',
        expandable: true,
        group: 'Actions',
        action: { type: 'enter-sessions' },
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

      const agentValue = row.value;
      const globalValue = getGlobalValue(row.name);
      let source: string;
      let effectiveValue: string;
      if (agentValue !== null && agentValue !== undefined) {
        source = 'agent';
        effectiveValue = agentValue;
      } else if (globalValue !== undefined) {
        source = 'global';
        effectiveValue = String(globalValue);
      } else {
        source = 'default';
        effectiveValue = '';
      }

      return {
        id: `setting:${row.name}`,
        title: row.name,
        subtitle: row.description,
        group,
        settingValue: effectiveValue,
        settingSource: source,
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
      globalConfigSet(name, rawValue);
    }
    return { success: true };
  }

  private clearAgentOverride(name: string): void {
    // system.* and plugin.* rows can't be deleted — set value to NULL instead
    if (name.startsWith('system.') || name.startsWith('plugin.')) {
      clearAgentConfig(this.deps.getAgentRoot(), name);
    } else {
      removeAgentConfig(this.deps.getAgentRoot(), name);
    }
  }

  clearToDefault(name: string): void {
    this.clearAgentOverride(name);
    globalConfigRemove(name);
    storeRemove(name);
  }

  async buildTaskItems(): Promise<CommandPaletteItem[]> {
    try {
      const tasks = await listTasks(this.deps.getAgentRoot());
      return tasks.map((task) => ({
        id: `task:${task.name}`,
        title: task.title,
        subtitle: task.description || undefined,
        group: 'Tasks' as const,
        action: {
          type: 'run-task' as const,
          taskName: task.name,
          taskTitle: task.title,
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

  async buildSessionItems(): Promise<CommandPaletteItem[]> {
    try {
      const sessions = await this.deps.getSessionManager().getSessionList();
      return sessions
        .filter((s) => s.file)
        .map((s) => {
          const subtitle = s.isStreaming ? 'streaming' : new Date(s.updatedAt).toLocaleString();
          return {
            id: `session:${s.file}`,
            title: s.label,
            subtitle,
            group: 'Sessions' as const,
            action: {
              type: 'load-session' as const,
              file: s.file!,
              label: s.label,
            },
          };
        });
    } catch (err) {
      console.error('[command-palette] getSessionList failed:', err);
      return [];
    }
  }

  private finishInstall(agentRoot: string, installResult: { installed: string[] }): { installed: string[] } {
    const pluginRegistry = this.deps.getPluginRegistry();
    if (pluginRegistry && installResult.installed.length > 0) {
      const db = getOrCreateAgentDb(agentRoot);
      for (const name of installResult.installed) {
        const row = db.getPlugin(name);
        if (row) pluginRegistry.reloadPlugin(row);
      }
    }

    if (installResult.installed.length > 0) {
      const names = installResult.installed.join(', ');
      this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:plugin-changed', {
        message: `Installed ${names}`,
      });
    }

    // Open welcome views (convention: plugin.<name>.welcome)
    const tabViewManager = this.deps.getTabViewManager();
    for (const name of installResult.installed) {
      const viewName = `plugin.${name}.welcome`;
      void getViewByName(agentRoot, viewName).then((view) => {
        if (view) {
          void tabViewManager.openTabHandler({
            viewName: view.name,
            title: view.title || view.name,
          }).catch((err) => {
            console.error(`[command-palette] failed to open welcome view ${viewName}:`, err);
          });
        }
      }).catch((err) => {
        console.error(`[command-palette] failed to resolve welcome view ${viewName}:`, err);
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

    const pluginRegistry = this.deps.getPluginRegistry();
    if (pluginRegistry) {
      pluginRegistry.unloadPlugin(pluginName);
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
        pluginRegistry.unloadPlugin(pluginName);
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
    const agentRoot = this.deps.getAgentRoot();
    packagePath = path.isAbsolute(packagePath) ? packagePath : path.resolve(agentRoot, packagePath);
    const packageData = readValidatedPackage(packagePath);
    const confirmation = this.deps.getConfirmation();
    const result = await confirmation.requestConfirmation('confirm-plugin-install', {
      packagePath,
      plugins: packageData.plugins.map(({ code, ...meta }) => meta),
    });
    if (!result.confirmed) {
      return { installed: [] };
    }
    return this.finishInstall(agentRoot, installPackageData(agentRoot, packageData));
  }

  async requestPluginToggle(pluginName: string): Promise<{ toggled: boolean; enabled?: boolean }> {
    const db = getOrCreateAgentDb(this.deps.getAgentRoot());
    const plugin = db.getPluginInfo(pluginName);
    if (!plugin) {
      throw new Error(`Plugin '${pluginName}' not found`);
    }
    const currentEnabled = !!plugin.enabled;
    const confirmation = this.deps.getConfirmation();
    const result = await confirmation.requestConfirmation('confirm-plugin-toggle', {
      pluginName,
      title: plugin.title,
      currentEnabled,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    });
    if (!result.confirmed) {
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
    const result = await confirmation.requestConfirmation('confirm-plugin-uninstall', {
      pluginName,
      title: plugin.title,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      license: plugin.license,
    });
    if (!result.confirmed) {
      return { uninstalled: false };
    }
    this.uninstallPluginByName(pluginName);
    return { uninstalled: true };
  }

  async requestAgentInstall(filePath: string): Promise<{ installed: boolean; agentRoot?: string }> {
    // Validate the .agent.awfy file
    const { DatabaseSync } = await import('node:sqlite');
    let viewsCount = 0, docsCount = 0, tasksCount = 0, pluginsCount = 0;
    try {
      const db = new DatabaseSync(filePath);
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
        if (!tables.includes('views') || !tables.includes('docs')) {
          throw new Error('Invalid agent file: missing required tables (views, docs)');
        }
        viewsCount = (db.prepare('SELECT COUNT(*) as c FROM views').get() as { c: number }).c;
        docsCount = (db.prepare('SELECT COUNT(*) as c FROM docs').get() as { c: number }).c;
        if (tables.includes('tasks')) {
          tasksCount = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
        }
        if (tables.includes('plugins')) {
          pluginsCount = (db.prepare('SELECT COUNT(*) as c FROM plugins').get() as { c: number }).c;
        }
      } finally {
        db.close();
      }
    } catch (err) {
      throw new Error(`Invalid agent file: ${err instanceof Error ? err.message : String(err)}`);
    }

    const confirmation = this.deps.getConfirmation();
    const result = await confirmation.requestConfirmation('confirm-agent-install', {
      filePath,
      viewsCount,
      docsCount,
      tasksCount,
      pluginsCount,
    }, { width: 440, height: 280 });

    if (!result.confirmed || !result.data?.directoryPath) {
      return { installed: false };
    }

    const targetDir = result.data.directoryPath as string;
    await initAgent(targetDir, filePath);

    await this.deps.addAgent(targetDir);
    return { installed: true, agentRoot: targetDir };
  }

  openSettingsFile(): void {
    ensureGlobalConfig();
    shell.openPath(getGlobalConfigPath());
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
          viewName: openViewAction.viewName,
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

      case 'toggle-zen-mode':
      case 'close-current-tab':
      case 'reload-current-tab':
      case 'new-session':
        this.deps.handleShortcutAction(action.type);
        break;

      case 'run-task': {
        const taskAction = action as Extract<CommandPaletteAction, { type: 'run-task' }>;
        this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:run-task', {
          taskName: taskAction.taskName,
          input: taskAction.input || undefined,
        });
        break;
      }

      case 'open-settings-file':
        this.openSettingsFile();
        break;

      case 'enter-settings':
      case 'enter-tasks':
      case 'enter-sessions':
        // Handled entirely in the palette UI
        return;

      case 'load-session': {
        const loadAction = action as Extract<CommandPaletteAction, { type: 'load-session' }>;
        this.hide({ focusMain: true });
        this.deps.rendererBridge.dispatchRendererCustomEvent('agentwfy:load-session', {
          file: loadAction.file,
          label: loadAction.label,
        });
        return;
      }

      case 'install-plugin': {
        this.hide({ focusMain: true });
        await this.installPluginFromDialog();
        return;
      }

      case 'edit-setting':
        // Handled entirely in the palette UI
        return;

      case 'add-agent': {
        this.hide({ focusMain: true });
        const picked = await showOpenAgentDialog(this.deps.getMainWindow());
        if (picked) await this.deps.addAgent(picked);
        return;
      }

      case 'import-agent-from-file': {
        this.hide({ focusMain: true });
        const installed = await showInstallAgentFromFileDialog(this.deps.getMainWindow());
        if (installed) await this.deps.addAgent(installed);
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
        this.deps.getTabViewManager().destroyAllTabViews();
        this.deps.getTabViewManager().clearTrackedViewWebContents();
        this.deps.reloadRenderer();
        return;
      }

      default:
        throw new Error(`Unsupported command palette action type: ${type}`);
    }

    this.hide({ focusMain: true });
  }
}
