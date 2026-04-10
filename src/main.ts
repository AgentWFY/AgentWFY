import { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, net, shell, webContents, type MenuItemConstructorOptions } from 'electron';
import { registerStoreHandlers, startFileWatcher, stopFileWatcher, onAnyChange } from './ipc/store.js';
import { registerViewHandlers } from './ipc/views.js';
import { registerDialogSubscribers } from './ipc/dialog.js';
import { registerSqlHandlers } from './ipc/sql.js';
import { registerTabsHandlers } from './ipc/tabs.js';
import { registerSessionsHandlers } from './ipc/sessions.js';
import { registerTabViewHandlers } from './tab-views/ipc.js';
import { registerCommandPaletteHandlers } from './command-palette/ipc.js';
import { registerTaskRunnerHandlers } from './task-runner/ipc.js';
import { registerAgentHandlers } from './ipc/agents.js';
import { registerConfirmationHandlers } from './confirmation/ipc.js';
import { registerProviderHandlers } from './ipc/providers.js';
import { registerRuntimeFunctionHandlers } from './ipc/runtime-functions.js';
import { registerAgentSessionHandlers, setupAgentStateStreaming } from './ipc/agent-sessions.js';
import {
  showOpenAgentDialog,
  showInstallAgentFromFileDialog,
  isAgentDir,
  isDefaultAgentPath,
  initAgent,
  createDefaultAgent,
} from './agent-manager.js';
import { windowManager, getPersistedAgentRoots } from './window-manager.js';
import { stopBackupScheduler, getBackupStatus } from './backup.js';
import { startAutoUpdater, stopAutoUpdater, checkForUpdates } from './auto-updater.js';
import { getViewByName } from './db/views.js';
import { getConfigValue } from './settings/config.js';
import { startGlobalConfigWatcher, stopGlobalConfigWatcher, onGlobalConfigChange } from './settings/global-config.js';
import { Channels } from './ipc/channels.js';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';

function devRebuild(): Promise<void> {
  if (app.isPackaged) return Promise.resolve();
  const root = path.join(import.meta.dirname, '..');
  const tsgo = path.join(root, 'vendor', 'tsgo', 'lib', process.platform === 'win32' ? 'tsgo.exe' : 'tsgo');
  return new Promise((resolve) => {
    execFile(tsgo, [], { cwd: root }, (err) => {
      if (err) console.error('[dev-rebuild] build failed:', err.message);
      resolve();
    });
  });
}

app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication');

if (process.env.AGENTWFY_HEADLESS && process.platform === 'darwin') {
  app.dock?.hide();
}

// Write main process logs to .dev.log when not packaged (readable via scripts/cdp logs)
if (!app.isPackaged) {
  const devLogStream = fs.createWriteStream(path.join(import.meta.dirname, '..', '.dev.log'), { flags: 'w' });
  devLogStream.on('error', () => {}); // ignore log file write failures
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: any, ...args: any[]) => {
    devLogStream.write(chunk);
    try { return origStdoutWrite(chunk, ...args); } catch { return false; }
  };
  process.stderr.write = (chunk: any, ...args: any[]) => {
    devLogStream.write(chunk);
    try { return origStderrWrite(chunk, ...args); } catch { return false; }
  };
}

const APP_NAME = process.env.AGENTWFY_APP_ID || 'AgentWFY';
const APP_ICON_PATH = path.join(import.meta.dirname, '..', 'icons', 'icon.png');

app.name = APP_NAME;

// Suppress Electron's automatic "Error occurred in handler for '...'" console.error
// messages from ipcMain.handle. These are expected validation errors from agent tool
// calls and are already propagated to the renderer as rejected promises.
const suppressedChannels = ['files:', 'sql:', 'tabs:', 'bus:', 'execJs:', 'plugin:'];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0]
  if (typeof first === 'string' && suppressedChannels.some((ch) => first.startsWith(`Error occurred in handler for '${ch}`))) return;
  originalConsoleError.apply(console, args);
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'agentview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const clientPath = path.join(import.meta.dirname, 'renderer', 'index.html');

// --- IPC registration (global, routes via windowManager) ---

registerStoreHandlers();
registerViewHandlers();
registerDialogSubscribers();

// Apply theme before window creation so titleBarOverlay picks up the right colors
windowManager.applyTheme();

const handleConfigChange = (key: string, newValue: unknown) => {
  if (key === 'system.theme') windowManager.applyTheme();
  windowManager.broadcastSettingChanged(key, newValue);
};
onAnyChange(handleConfigChange);
onGlobalConfigChange(handleConfigChange);

registerSqlHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (event, change) => windowManager.onDbChange(event, change),
);
registerTabsHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).tabTools,
  (e) => windowManager.getAgentRootForEvent(e),
);
registerSessionsHandlers((e) => windowManager.getAgentRootForEvent(e));
registerTabViewHandlers((e) => windowManager.getContextForSender(e.sender.id).tabViewManager);
registerCommandPaletteHandlers(() => windowManager.getCommandPalette());
registerTaskRunnerHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (e) => windowManager.getContextForSender(e.sender.id).taskRunner,
);
registerRuntimeFunctionHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).functionRegistry,
);
registerAgentHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  () => windowManager.getCommandPalette(),
);
registerConfirmationHandlers(() => windowManager.getConfirmation());
const reconnectSessionManager = async (e: Electron.IpcMainInvokeEvent) => {
  const ctx = windowManager.getContextForSender(e.sender.id);
  // Dispose old streaming and session manager
  ctx.agentStateStreamingCleanup?.();
  await ctx.sessionManager.disposeAll();
  // Create new session manager
  const { AgentSessionManager } = await import('./agent/session_manager.js');
  const agentRootForReconnect = ctx.agentRoot;
  const newMgr = new AgentSessionManager({
    agentRoot: agentRootForReconnect,
    providerRegistry: ctx.providerRegistry,
    getJsRuntime: () => ctx.jsRuntime,
    busPublish: (topic, data) => ctx.eventBus.publish(topic, data),
  });
  ctx.sessionManager = newMgr;
  const rwc = windowManager.getRendererWebContents();
  if (rwc) {
    ctx.agentStateStreamingCleanup = setupAgentStateStreaming(
      newMgr, rwc, () => windowManager.getActiveAgentRoot() === agentRootForReconnect
    );
  }
  newMgr.resetActive();
  return newMgr;
};
registerProviderHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).providerRegistry,
  (e) => windowManager.getAgentRootForEvent(e),
  () => windowManager.getRendererWebContents() ?? undefined,
  reconnectSessionManager,
  (agentRoot, change) => windowManager.notifyDbChange(agentRoot, change),
);
registerAgentSessionHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).sessionManager,
  reconnectSessionManager,
);

ipcMain.handle('app:restart', async () => {
  await devRebuild();
  app.exit(100); // exit 100 = start.mjs respawns
});

ipcMain.handle('app:stop', () => {
  app.exit(0);
});

ipcMain.handle('app:reloadRenderer', async () => {
  await devRebuild();
  for (const wc of webContents.getAllWebContents()) {
    wc.reloadIgnoringCache();
  }
});

ipcMain.handle('app:getAgentRoot', () => {
  return windowManager.getActiveAgentRoot();
});

ipcMain.on('app:getAgentRoot', (event) => {
  event.returnValue = windowManager.getActiveAgentRoot();
});

ipcMain.handle('app:openAgentRoot', () => {
  const root = windowManager.getActiveAgentRoot();
  if (root) shell.openPath(root);
});

ipcMain.handle('app:getAgentDisplayPath', () => {
  const root = windowManager.getActiveAgentRoot();
  if (!root) return null;
  if (isDefaultAgentPath(root)) return path.basename(root);
  const home = app.getPath('home');
  if (root.startsWith(home)) return '~' + root.slice(home.length);
  return root;
});

ipcMain.handle('app:getHttpApiPort', () => {
  try {
    return windowManager.getActiveHttpApiPort();
  } catch {
    return null;
  }
});

ipcMain.handle('app:getDefaultView', async () => {
  try {
    const root = windowManager.getActiveAgentRoot();
    if (!root) return null;
    const configValue = getConfigValue(root, 'system.default-view', 'home');
    const trimmed = typeof configValue === 'string' ? configValue.trim() : '';
    const viewName = trimmed || 'home';
    const view = await getViewByName(root, viewName);
    if (!view) return null;
    return { viewName: view.name, title: view.title || view.name, viewUpdatedAt: view.updated_at };
  } catch {
    return null;
  }
});

ipcMain.handle('app:getBackupStatus', () => {
  try {
    const root = windowManager.getActiveAgentRoot();
    if (!root) return null;
    return getBackupStatus(root);
  } catch {
    return null;
  }
});

// --- Agent sidebar IPC handlers ---

ipcMain.handle(Channels.agentSidebar.getInstalled, () => {
  return windowManager.getInstalledAgentsList();
});

ipcMain.handle(Channels.agentSidebar.switch, async (_event, agentRoot: string) => {
  await windowManager.switchAgent(agentRoot);
});

ipcMain.handle(Channels.agentSidebar.add, async () => {
  const win = windowManager.getMainWindow();
  const picked = await showOpenAgentDialog(win);
  if (!picked) return null;
  await windowManager.addAgent(picked);
  return picked;
});

ipcMain.handle(Channels.agentSidebar.addFromFile, async () => {
  const win = windowManager.getMainWindow();
  const picked = await showInstallAgentFromFileDialog(win);
  if (!picked) return null;
  await windowManager.addAgent(picked);
  return picked;
});

ipcMain.handle(Channels.agentSidebar.remove, async (_event, agentRoot: string) => {
  await windowManager.removeAgent(agentRoot);
});

ipcMain.handle(Channels.agentSidebar.reorder, async (_event, fromIndex: number, toIndex: number) => {
  windowManager.reorderAgents(fromIndex, toIndex);
});

ipcMain.handle(Channels.agentSidebar.showContextMenu, async (_event, agentRoot: string) => {
  const win = windowManager.getMainWindow();
  if (!win || win.isDestroyed()) return;

  const agents = windowManager.getInstalledAgentsList();
  const canRemove = agents.length > 1;

  const template: MenuItemConstructorOptions[] = [];
  if (canRemove) {
    template.push({
      label: 'Close Agent',
      click: () => windowManager.removeAgent(agentRoot),
    });
  }

  if (template.length === 0) return;
  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: win });
});

// --- Zen mode sync ---

ipcMain.handle(Channels.zenMode.toggle, () => {
  windowManager.toggleZenMode();
});

ipcMain.handle(Channels.zenMode.set, (_event, value: boolean) => {
  windowManager.setZenMode(!!value);
});

// --- Menu ---

function buildAndSetMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Default Agent',
          click: async () => {
            const dirPath = await createDefaultAgent();
            await windowManager.addAgent(dirPath);
          },
        },
        {
          label: 'Add Agent to Directory...',
          click: async () => {
            const win = windowManager.getMainWindow();
            const picked = await showOpenAgentDialog(win);
            if (picked) await windowManager.addAgent(picked);
          },
        },
        {
          label: 'Import Agent from File...',
          click: async () => {
            const win = windowManager.getMainWindow();
            const picked = await showInstallAgentFromFileDialog(win);
            if (picked) await windowManager.addAgent(picked);
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          click: () => {
            windowManager.handleShortcutAction('toggle-dev-tools');
          },
        },
        { type: 'separator' },
        {
          label: 'Reload Renderer',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            devRebuild().then(() => {
              for (const wc of webContents.getAllWebContents()) {
                wc.reloadIgnoringCache();
              }
            });
          },
        },
        {
          label: 'Restart App',
          accelerator: 'CmdOrCtrl+Shift+Alt+R',
          click: () => {
            devRebuild().then(() => app.exit(100));
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const }
            ]
          : [
              { role: 'close' as const }
            ])
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            const win = BaseWindow.getFocusedWindow() ?? undefined;
            dialog.showMessageBox({
              ...(win ? { window: win } : {}),
              type: 'info',
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: `Version ${app.getVersion()}`,
              icon: nativeImage.createFromPath(APP_ICON_PATH),
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates(false),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- CLI argument parsing ---

function getAgentPathFromArgs(): string | null {
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--agent-path=')) {
      return args[i].split('=').slice(1).join('=');
    }
    if (args[i] === '--agent-path' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

// --- Initial window creation ---

async function createInitialWindow() {
  // 1. Check CLI argument
  const cliAgentPath = getAgentPathFromArgs();
  if (cliAgentPath) {
    const resolved = path.resolve(cliAgentPath);
    if (!isAgentDir(resolved)) {
      // Initialize as a new agent directory (creates .agentwfy/ and seeds default agent)
      await initAgent(resolved);
    }
    if (isAgentDir(resolved)) {
      // Register all persisted agents in sidebar without initializing
      const persisted = getPersistedAgentRoots().filter(r => isAgentDir(r));
      for (const root of persisted) {
        windowManager.addPersistedAgent(root);
      }
      // Ensure CLI agent is in the list
      windowManager.addPersistedAgent(resolved);
      // Only initialize and activate the CLI agent
      await windowManager.createMainWindow(resolved);
      return;
    }
    console.error(`[main] --agent-path "${cliAgentPath}" failed to initialize`);
  }

  // 2. Try persisted agents (register all, only init the first one)
  const persisted = getPersistedAgentRoots().filter(r => isAgentDir(r));
  if (persisted.length > 0) {
    for (const root of persisted) {
      windowManager.addPersistedAgent(root);
    }
    await windowManager.createMainWindow(persisted[0]);
    return;
  }

  // 3. No persisted agents — create a default agent
  const defaultAgentPath = await createDefaultAgent();
  windowManager.addPersistedAgent(defaultAgentPath);
  await windowManager.createMainWindow(defaultAgentPath);
}

// --- App lifecycle ---

app.on('ready', async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(import.meta.dirname, '..', 'icons', 'icon.png'));
  }

  startFileWatcher();
  startGlobalConfigWatcher();

  buildAndSetMenu();

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  startAutoUpdater();

  createInitialWindow();
});

app.on('web-contents-created', (_event, webContents) => {
  if (webContents.getType() !== 'webview') return;

  const hostWc = (webContents as Electron.WebContents & { hostWebContents?: Electron.WebContents }).hostWebContents;
  const ownerWin = hostWc
    ? BrowserWindow.fromWebContents(hostWc)
    : BrowserWindow.fromWebContents(webContents);

  if (ownerWin) {
    const ctx = windowManager.tryGetContextForSender(ownerWin.webContents.id);
    if (ctx) {
      ctx.tabViewManager.registerWebContentsTracking(_event, webContents);
      return;
    }
  }

  const contexts = windowManager.getAllContexts();
  if (contexts.length === 1) {
    contexts[0].tabViewManager.registerWebContentsTracking(_event, webContents);
  } else {
    console.warn('[web-contents-created] Could not determine owning window for webview; skipping registration');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let forceQuit = false;
let quitDialogOpen = false;

function doQuitCleanup() {
  stopFileWatcher();
  stopGlobalConfigWatcher();
  stopBackupScheduler();
  stopAutoUpdater();
  windowManager.destroyAll();
}

app.on('before-quit', (event) => {
  if (forceQuit) {
    doQuitCleanup();
    return;
  }

  if (!windowManager.hasActiveWork()) {
    doQuitCleanup();
    return;
  }

  event.preventDefault();
  if (quitDialogOpen) return;
  quitDialogOpen = true;

  windowManager.showQuitConfirmation().then((confirmed) => {
    quitDialogOpen = false;
    if (confirmed) {
      forceQuit = true;
      app.quit();
    }
  });
});

app.on('activate', () => {
  if (BaseWindow.getAllWindows().length === 0) {
    createInitialWindow();
  }
});
