import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, net } from 'electron';
import { registerStoreHandlers, startFileWatcher, stopFileWatcher, getStorePath, onAnyChange } from './ipc/store.js';
import { registerDialogSubscribers } from './ipc/dialog.js';
import { registerFilesHandlers } from './ipc/files.js';
import { registerSqlHandlers } from './ipc/sql.js';
import { registerTabsHandlers } from './ipc/tabs.js';
import { registerSessionsHandlers } from './ipc/sessions.js';
import { registerAuthHandlers } from './ipc/auth.js';
import { registerBusHandlers, forwardBusPublish, forwardBusWaitFor, forwardBusSubscribe, forwardBusUnsubscribe } from './ipc/bus.js';
import { registerRequestHeadersHandlers, installWebRequestHooks } from './ipc/request-headers.js';
import { registerTabViewHandlers } from './tab-views/ipc.js';
import { registerCommandPaletteHandlers } from './command-palette/ipc.js';
import { registerTaskRunnerHandlers, forwardStartTask } from './task-runner/ipc.js';
import type { AgentDbChange } from './db/sqlite.js';
import { RendererBridge } from './renderer-bridge.js';
import { TabViewManager } from './tab-views/manager.js';
import { CommandPaletteManager, COMMAND_PALETTE_CHANNEL } from './command-palette/manager.js';
import { createViewProtocolHandler } from './protocol/view-handler.js';
import {
  getAgentRoot,
  ensureAgentRuntimeBootstrap,
  getCurrentAgentRoot,
  showAgentPickerDialog,
  showOpenAgentDialog,
  showInstallAgentDialog,
  openAgent,
  onAgentRootChanged,
  getRecentAgents,
  isAgentDir,
  shortenPath,
} from './agent-manager.js';
import { startHttpApi } from './http-api/server.js';
import type { HttpApiServer } from './http-api/server.js';
import { TriggerEngine } from './triggers/engine.js';
import { scheduleBackup, stopBackupScheduler, getBackupStatus } from './backup.js';
import path from 'path';
import { pathToFileURL } from 'url';

app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication');

// Suppress Electron's automatic "Error occurred in handler for '...'" console.error
// messages from ipcMain.handle. These are expected validation errors from agent tool
// calls and are already propagated to the renderer as rejected promises.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'files:')) return;
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'sql:')) return;
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'tabs:')) return;
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'bus:')) return;
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'headers:')) return;
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

let mainWindow: BrowserWindow | null;
let httpApi: HttpApiServer | null = null;
let triggerEngine: TriggerEngine | null = null;

const clientPath = path.join(import.meta.dirname, 'client', 'index.html');

// --- Module instantiation + dependency wiring ---

const rendererBridge = new RendererBridge({
  getMainWindow: () => mainWindow,
});

const tabViewManager = new TabViewManager({
  getMainWindow: () => mainWindow,
  toggleCommandPalette: () => commandPalette.toggle(),
  focusMainRendererWindow: () => rendererBridge.focusMainRendererWindow(),
  dispatchRendererCustomEvent: (name, detail) => rendererBridge.dispatchRendererCustomEvent(name, detail),
  dispatchRendererWindowEvent: (name) => rendererBridge.dispatchRendererWindowEvent(name),
});

const commandPalette = new CommandPaletteManager({
  getMainWindow: () => mainWindow,
  getAgentRoot,
  rendererBridge,
  getTabViewManager: () => tabViewManager,
  getStorePath,
});

// --- IPC registration ---

registerStoreHandlers();
registerDialogSubscribers();

onAnyChange((key, newValue) => {
  const cpWindow = commandPalette.getWindow();
  if (cpWindow && !cpWindow.isDestroyed()) {
    cpWindow.webContents.send(COMMAND_PALETTE_CHANNEL.SETTING_CHANGED, { key, value: newValue });
  }
});

let dbChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let triggerReloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function onDbChange(change: AgentDbChange): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('bus:dbChanged', change);

  // Debounced reload of triggers when the triggers table changes
  if (change.table === 'triggers' && triggerEngine) {
    if (triggerReloadDebounceTimer) clearTimeout(triggerReloadDebounceTimer);
    triggerReloadDebounceTimer = setTimeout(() => {
      triggerEngine?.reload().catch(err => {
        console.error('[triggers] Reload failed:', err);
      });
    }, 500);
  }

  // Debounced backup status refresh so status line updates modified indicator
  if (dbChangeDebounceTimer) clearTimeout(dbChangeDebounceTimer);
  dbChangeDebounceTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    rendererBridge.dispatchRendererWindowEvent('agentwfy:backup-changed');
  }, 5000);
}

const tabTools = {
  getTabs: () => tabViewManager.getTabsHandler(),
  openTab: (req: Parameters<typeof tabViewManager.openTabHandler>[0]) => tabViewManager.openTabHandler(req),
  closeTab: (req: Parameters<typeof tabViewManager.closeTabHandler>[0]) => tabViewManager.closeTabHandler(req),
  selectTab: (req: Parameters<typeof tabViewManager.selectTabHandler>[0]) => tabViewManager.selectTabHandler(req),
  reloadTab: (req: Parameters<typeof tabViewManager.reloadTabHandler>[0]) => tabViewManager.reloadTabHandler(req),
  captureTab: (req: Parameters<typeof tabViewManager.captureTabById>[0]) => tabViewManager.captureTabById(req),
  getTabConsoleLogs: (req: Parameters<typeof tabViewManager.getTabConsoleLogsById>[0]) => tabViewManager.getTabConsoleLogsById(req),
  execTabJs: (req: Parameters<typeof tabViewManager.execTabJsById>[0]) => tabViewManager.execTabJsById(req),
};

registerFilesHandlers(getAgentRoot);
registerSqlHandlers(getAgentRoot, onDbChange);
registerTabsHandlers(tabTools);
registerSessionsHandlers(getAgentRoot);
registerAuthHandlers(getAgentRoot);
registerRequestHeadersHandlers();

registerTabViewHandlers(tabViewManager);
registerCommandPaletteHandlers(commandPalette);
registerTaskRunnerHandlers(getAgentRoot, () => mainWindow);

ipcMain.handle('app:getAgentRoot', () => getCurrentAgentRoot());

ipcMain.handle('app:getBackupStatus', () => {
  const root = getCurrentAgentRoot();
  if (!root) return null;
  return getBackupStatus(root);
});

// --- Agent root change listener ---

onAgentRootChanged(async (newRoot) => {
  commandPalette.destroy();
  tabViewManager.destroyAllTabViews();
  tabViewManager.clearTrackedViewWebContents();
  if (triggerEngine) {
    if (triggerReloadDebounceTimer) {
      clearTimeout(triggerReloadDebounceTimer);
      triggerReloadDebounceTimer = null;
    }
    triggerEngine.stop();
  }
  await ensureAgentRuntimeBootstrap(newRoot);
  scheduleBackup(newRoot).then(() => {
    rendererBridge.dispatchRendererWindowEvent('agentwfy:backup-changed');
  }).catch((err) => console.error('[backup] Schedule failed:', err));
  mainWindow?.reload();
  buildAndSetMenu();
  if (triggerEngine && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      triggerEngine?.start().catch(err => console.error('[triggers] Start after agent switch failed:', err));
    });
  }
});

// --- App window creation ---

async function createAppWindow(agentRoot: string) {
  await ensureAgentRuntimeBootstrap(agentRoot);

  mainWindow = new BrowserWindow({
    show: false,
    title: agentRoot,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 13, y: 12 } }
      : {
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f0f0f0',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#808080' : '#999999',
            height: 36,
          },
        }),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      webSecurity: false,
    },
  });

  mainWindow.on('page-title-updated', (evt) => {
    evt.preventDefault();
  });

  mainWindow.on('closed', () => {
    commandPalette.destroy();
    tabViewManager.destroyAllTabViews();
  });

  mainWindow.on('move', () => {
    commandPalette.syncBounds();
  });

  mainWindow.on('resize', () => {
    commandPalette.syncBounds();
  });

  registerBusHandlers(mainWindow);

  mainWindow.maximize();

  mainWindow.webContents.on('did-start-loading', () => {
    commandPalette.destroy();
    tabViewManager.destroyAllTabViews();
  });

  mainWindow.loadURL('app://index.html');

  mainWindow.show();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (!key || input.alt || input.isAutoRepeat) {
      return;
    }

    const hasCommandModifier = process.platform === 'darwin' ? input.meta : input.control;
    if (!hasCommandModifier) {
      return;
    }

    if (!input.shift && key === 'k') {
      event.preventDefault();
      commandPalette.toggle();
      return;
    }

    if (!input.shift && key === 'i') {
      event.preventDefault();
      rendererBridge.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
      return;
    }

    if (!input.shift && key === 'w') {
      event.preventDefault();
      rendererBridge.dispatchRendererWindowEvent('agentwfy:remove-current-tab');
      return;
    }

    if (!input.shift && key === 'r') {
      event.preventDefault();
      tabViewManager.reloadVisibleTabView();
    }
  });
}

async function createWindow() {
  let agentRoot = getCurrentAgentRoot();

  // Try most recent agent on fresh launch
  if (!agentRoot) {
    const recents = getRecentAgents();
    if (recents[0] && isAgentDir(recents[0].path)) {
      agentRoot = recents[0].path;
    }
  }

  if (agentRoot) {
    openAgent(agentRoot);
    return createAppWindow(agentRoot);
  }

  // No agent found — show picker
  const picked = await showAgentPickerDialog();
  if (!picked) {
    app.quit();
    return;
  }

  openAgent(picked);
  await createAppWindow(picked);
}

// --- Agent actions from menu / command palette ---

async function handleOpenAgent() {
  const picked = await showOpenAgentDialog(mainWindow);
  if (!picked) return;
  openAgent(picked);
}

async function handleInstallAgent() {
  const picked = await showInstallAgentDialog(mainWindow);
  if (!picked) return;
  openAgent(picked);
}

async function handleSwitchAgent(agentPath: string) {
  if (!isAgentDir(agentPath)) {
    const picked = await showOpenAgentDialog(mainWindow);
    if (!picked) return;
    openAgent(picked);
    return;
  }
  openAgent(agentPath);
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
            mainWindow?.webContents.openDevTools();
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
        { role: 'about' },
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

// --- App lifecycle ---

app.on('ready', async () => {
  installWebRequestHooks();
  startFileWatcher();

  httpApi = startHttpApi({
    getAgentRoot,
  });

  triggerEngine = new TriggerEngine({
    getAgentRoot,
    startTask: (taskId, input?, origin?) => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
      return forwardStartTask(mainWindow, taskId, input, origin);
    },
    busWaitFor: (topic, timeoutMs?) => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
      return forwardBusWaitFor(mainWindow, topic, timeoutMs);
    },
    busSubscribe: (topic, fn) => {
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is not available');
      const subId = forwardBusSubscribe(mainWindow, topic, fn);
      return () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          forwardBusUnsubscribe(mainWindow, subId);
        }
      };
    },
    httpApi,
  });

  triggerEngine.start().catch(err => {
    console.error('[triggers] Initial start failed:', err);
  });

  buildAndSetMenu();

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  const handleViewRequest = createViewProtocolHandler({ getAgentRoot, clientPath });
  protocol.handle('agentview', (request) => {
    return handleViewRequest(request);
  });

  createWindow();
});

app.on('web-contents-created', (event, webContents) => {
  tabViewManager.registerWebContentsTracking(event, webContents);
});

app.on('window-all-closed', () => {
  commandPalette.destroy();
  tabViewManager.destroyAllTabViews();
  tabViewManager.clearTrackedViewWebContents();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopFileWatcher();
  stopBackupScheduler();
  triggerEngine?.stop();
  httpApi?.server.close();
  commandPalette.destroy();
  tabViewManager.destroyAllTabViews();
  tabViewManager.clearTrackedViewWebContents();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
