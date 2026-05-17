import { app, ipcMain, shell, webContents, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { getViewByName } from '#shared/db/views.js';
import { getConfigValue } from '#shared/settings/config.js';
import { SystemConfigKeys } from '#shared/system-config/keys.js';
import type { AgentBackend } from '#shared/backend/interface.js';
import { isDefaultAgentPath } from '../agent-manager.js';
import { Channels } from './channels.cjs';

interface AppHandlerDeps {
  devRebuild: () => Promise<void>;
  getActiveAgentId: () => string | null;
  getActiveHttpApiPort: () => number | null;
  getActiveCacheRoot: () => string | null;
  getActiveBackend: () => AgentBackend | null;
  getCacheRootForEvent: (event: IpcMainInvokeEvent) => string;
}

export function registerAppHandlers(deps: AppHandlerDeps): void {
  ipcMain.handle(Channels.app.restart, async () => {
    await deps.devRebuild();
    app.exit(100); // exit 100 = start.mjs respawns
  });

  ipcMain.handle(Channels.app.stop, () => {
    app.exit(0);
  });

  ipcMain.handle(Channels.app.reloadRenderer, async () => {
    await deps.devRebuild();
    for (const wc of webContents.getAllWebContents()) {
      wc.reloadIgnoringCache();
    }
  });

  ipcMain.handle(Channels.app.getAgentId, () => {
    return deps.getActiveAgentId();
  });

  ipcMain.on(Channels.app.getAgentId, (event) => {
    event.returnValue = deps.getActiveAgentId();
  });

  ipcMain.handle(Channels.app.openAgentDir, () => {
    const root = deps.getActiveAgentId();
    if (root) void shell.openPath(root);
  });

  ipcMain.handle(Channels.app.getAgentDisplayPath, () => {
    const root = deps.getActiveAgentId();
    if (!root) return null;
    if (isDefaultAgentPath(root)) return path.basename(root);
    const home = app.getPath('home');
    if (root.startsWith(home)) return '~' + root.slice(home.length);
    return root;
  });

  ipcMain.handle(Channels.app.getHttpApiPort, () => {
    try {
      return deps.getActiveHttpApiPort();
    } catch {
      return null;
    }
  });

  ipcMain.handle(Channels.app.getDefaultView, async () => {
    try {
      const root = deps.getActiveCacheRoot();
      if (!root) return null;
      const configValue = getConfigValue(root, SystemConfigKeys.defaultView, 'home');
      const trimmed = typeof configValue === 'string' ? configValue.trim() : '';
      const viewName = trimmed || 'home';
      const view = await getViewByName(root, viewName);
      if (!view) return null;
      return { viewName: view.name, title: view.title || view.name, viewUpdatedAt: view.updated_at };
    } catch {
      return null;
    }
  });

  ipcMain.handle(Channels.app.getBackupStatus, async () => {
    try {
      const backend = deps.getActiveBackend();
      if (!backend) return null;
      return await backend.backup.status();
    } catch {
      return null;
    }
  });

  ipcMain.handle(Channels.app.getSetting, (event, key: string, fallback?: unknown) => {
    const root = deps.getCacheRootForEvent(event);
    return getConfigValue(root, key, fallback) ?? null;
  });
}
