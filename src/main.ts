import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, net } from 'electron';
import { registerStoreHandlers, startFileWatcher, stopFileWatcher, onAnyChange } from './ipc/store.js';
import { registerDialogSubscribers } from './ipc/dialog.js';
import { registerFilesHandlers } from './ipc/files.js';
import { registerSqlHandlers } from './ipc/sql.js';
import { registerTabsHandlers } from './ipc/tabs.js';
import { registerSessionsHandlers } from './ipc/sessions.js';
import { registerBusHandlers } from './ipc/bus.js';
import { registerTabViewHandlers } from './tab-views/ipc.js';
import { registerCommandPaletteHandlers } from './command-palette/ipc.js';
import { registerTaskRunnerHandlers } from './task-runner/ipc.js';
import { registerPluginHandlers } from './ipc/plugins.js';
import { registerAgentHandlers } from './ipc/agents.js';
import { registerConfirmationHandlers } from './confirmation/ipc.js';
import { registerProviderHandlers } from './ipc/providers.js';
import { registerRuntimeFunctionHandlers } from './ipc/runtime-functions.js';
import { registerAgentSessionHandlers, setupAgentStateStreaming } from './ipc/agent-sessions.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';
import {
  showAgentPickerDialog,
  showOpenAgentDialog,
  showInstallAgentDialog,
  showInstallAgentFromFileDialog,
  getRecentAgents,
  isAgentDir,
  shortenPath,
} from './agent-manager.js';
import { windowManager } from './window-manager.js';
import { stopBackupScheduler, getBackupStatus } from './backup.js';
import { getViewByName } from './db/views.js';
import { getConfigValue } from './settings/config.js';
import path from 'path';
import { pathToFileURL } from 'url';

app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication');

const APP_NAME = 'AgentWFY';
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

const clientPath = path.join(import.meta.dirname, 'client', 'index.html');

// --- IPC registration (global, routes via windowManager) ---

registerStoreHandlers();
registerDialogSubscribers();

onAnyChange((key, newValue) => {
  windowManager.broadcastSettingChanged(key, newValue);
});

registerFilesHandlers((e) => windowManager.getAgentRootForEvent(e));
registerSqlHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (event, change) => windowManager.onDbChange(event, change),
);
registerTabsHandlers((e) => windowManager.getContextForSender(e.sender.id).tabTools);
registerSessionsHandlers((e) => windowManager.getAgentRootForEvent(e));
registerBusHandlers(
  (e) => windowManager.getWindowForEvent(e),
);
registerTabViewHandlers((e) => windowManager.getContextForSender(e.sender.id).tabViewManager);
registerCommandPaletteHandlers((e) => windowManager.getContextForSender(e.sender.id).commandPalette);
registerTaskRunnerHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (e) => windowManager.getContextForSender(e.sender.id).taskRunner,
);
registerPluginHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (e) => windowManager.getContextForSender(e.sender.id).functionRegistry,
  (e) => windowManager.getContextForSender(e.sender.id).pluginRegistry,
  (e) => windowManager.getContextForSender(e.sender.id).commandPalette,
);
registerRuntimeFunctionHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).functionRegistry,
);
registerAgentHandlers(
  (e) => windowManager.getAgentRootForEvent(e),
  (e) => windowManager.getContextForSender(e.sender.id).commandPalette,
);
registerConfirmationHandlers((e) => windowManager.getContextForSender(e.sender.id).confirmation);
registerProviderHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).providerRegistry,
);
registerAgentSessionHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).sessionManager,
  async (e) => {
    const ctx = windowManager.getContextForSender(e.sender.id);
    // Dispose old streaming and session manager
    ctx.agentStateStreamingCleanup?.();
    await ctx.sessionManager.disposeAll();
    // Create new session manager
    const { AgentSessionManager } = await import('./agent/session_manager.js');
    const newMgr = new AgentSessionManager({
      agentRoot: ctx.agentRoot,
      win: ctx.window,
      providerRegistry: ctx.providerRegistry,
      getJsRuntime: () => ctx.jsRuntime,
    });
    ctx.sessionManager = newMgr;
    ctx.agentStateStreamingCleanup = setupAgentStateStreaming(newMgr, ctx.window);
    newMgr.resetActive();
    return newMgr;
  },
);

ipcMain.handle('app:getAgentRoot', (event) => {
  try {
    return windowManager.getAgentRootForEvent(event);
  } catch {
    return null;
  }
});

ipcMain.handle('app:getHttpApiPort', (event) => {
  try {
    const ctx = windowManager.getContextForSender(event.sender.id);
    return ctx.httpApi?.port() ?? null;
  } catch {
    return null;
  }
});

ipcMain.handle('app:getDefaultView', async (event) => {
  try {
    const root = windowManager.getAgentRootForEvent(event);
    const configValue = getConfigValue(root, 'system.defaultView', 'home');
    const trimmed = typeof configValue === 'string' ? configValue.trim() : '';
    const viewName = trimmed || 'home';
    const view = await getViewByName(root, viewName);
    if (!view) return null;
    return { viewId: view.id, title: view.title || view.name, viewUpdatedAt: view.updated_at };
  } catch {
    return null;
  }
});

ipcMain.handle('app:getBackupStatus', (event) => {
  try {
    const root = windowManager.getAgentRootForEvent(event);
    return getBackupStatus(root);
  } catch {
    return null;
  }
});

// --- Agent actions from menu / command palette ---

async function handleOpenAgent() {
  const picked = await showOpenAgentDialog(BrowserWindow.getFocusedWindow());
  if (!picked) return;
  await windowManager.openAgentInWindow(picked);
}

async function handleInstallAgent() {
  const picked = await showInstallAgentDialog(BrowserWindow.getFocusedWindow());
  if (!picked) return;
  await windowManager.openAgentInWindow(picked);
}

async function handleInstallAgentFromFile() {
  const picked = await showInstallAgentFromFileDialog(BrowserWindow.getFocusedWindow());
  if (!picked) return;
  await windowManager.openAgentInWindow(picked);
}

async function handleSwitchAgent(agentPath: string) {
  if (!isAgentDir(agentPath)) {
    const picked = await showOpenAgentDialog(BrowserWindow.getFocusedWindow());
    if (!picked) return;
    await windowManager.openAgentInWindow(picked);
    return;
  }
  await windowManager.openAgentInWindow(agentPath);
}

// --- Menu ---

function buildAndSetMenu() {
  const recents = getRecentAgents();
  const recentItems: Electron.MenuItemConstructorOptions[] = recents.map((r) => ({
    label: shortenPath(r.path),
    click: () => handleSwitchAgent(r.path),
  }));

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Agent...',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpenAgent(),
        },
        {
          label: 'Install Agent...',
          click: () => handleInstallAgent(),
        },
        {
          label: 'Install Agent from .agent.awfy...',
          click: () => handleInstallAgentFromFile(),
        },
        { type: 'separator' },
        ...(recentItems.length > 0
          ? [
              {
                label: 'Recent Agents',
                submenu: recentItems,
              } as Electron.MenuItemConstructorOptions,
              { type: 'separator' as const },
            ]
          : []),
        {
          label: 'Devtools',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            win?.webContents.openDevTools();
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
        { role: 'toggleDevTools' },
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
            const win = BrowserWindow.getFocusedWindow() ?? undefined;
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
  // Skip electron binary and app path; look for --agent-path=<path> or --agent-path <path>
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
  // Check for --agent-path CLI argument first
  const cliAgentPath = getAgentPathFromArgs();
  if (cliAgentPath) {
    const resolved = path.resolve(cliAgentPath);
    if (isAgentDir(resolved)) {
      await windowManager.createWindow(resolved, { skipRecents: true });
      buildAndSetMenu();
      return;
    }
    console.error(`[main] --agent-path "${cliAgentPath}" is not a valid agent directory (missing .agentwfy/)`);
  }

  // Try most recent agent on fresh launch
  const recents = getRecentAgents();
  const agentRoot = recents[0] && isAgentDir(recents[0].path) ? recents[0].path : null;

  if (agentRoot) {
    await windowManager.createWindow(agentRoot);
    buildAndSetMenu();
    return;
  }

  // No agent found — show picker
  const picked = await showAgentPickerDialog();
  if (!picked) {
    app.quit();
    return;
  }

  await windowManager.createWindow(picked);
  buildAndSetMenu();
}

// --- App lifecycle ---

app.on('ready', async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(import.meta.dirname, '..', 'icons', 'icon.png'));
  }

  startFileWatcher();

  buildAndSetMenu();

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  const handleViewRequest = createViewProtocolHandler({
    getAgentRoot: (hash) => {
      if (hash) {
        return windowManager.getAgentRootForHash(hash);
      }
      // Fallback: if no hash, try to find the only open agent
      const contexts = windowManager.getAllContexts();
      if (contexts.length === 1) return contexts[0].agentRoot;
      return null;
    },
    clientPath,
  });
  protocol.handle('agentview', (request) => {
    return handleViewRequest(request);
  });

  // Rebuild menu whenever a new window is created (updates recent agents list)
  windowManager.onWindowCreated = () => buildAndSetMenu();

  createInitialWindow();
});

app.on('web-contents-created', (_event, webContents) => {
  if (webContents.getType() !== 'webview') return;

  // Find owning window via hostWebContents → BrowserWindow lookup
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

  // Fallback: only register if there's exactly one window (unambiguous owner)
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
  stopBackupScheduler();
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createInitialWindow();
  }
});
