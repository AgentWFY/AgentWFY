import { app, BrowserWindow, Menu, protocol, net } from 'electron';
import createVaultWindow from './vault_window';
import { registerStoreHandlers, storeGet, onDidChange } from './ipc/store';
import { registerDialogSubscribers } from './ipc/dialog';
import { registerAgentToolsHandlers } from './ipc/agent-tools';
import { registerBusHandlers } from './ipc/bus';
import { registerTabViewHandlers } from './tab-views/ipc';
import { registerCommandPaletteHandlers } from './command-palette/ipc';
import { AgentDbChangesPublisher, type AgentDbChangedEvent } from './db/changes';
import { RendererBridge } from './renderer-bridge';
import { TabViewManager } from './tab-views/manager';
import { CommandPaletteManager } from './command-palette/manager';
import { createViewProtocolHandler } from './protocol/view-handler';
import { DEFAULT_DATA_DIR, getDataDir, ensureAgentRuntimeBootstrap } from './data-dir';
import path from 'path';
import { pathToFileURL } from 'url';

// Suppress Electron's automatic "Error occurred in handler for '...'" console.error
// messages from ipcMain.handle. These are expected validation errors from agent tool
// calls and are already propagated to the renderer as rejected promises.
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'agentwfy:')) return;
  if (typeof args[0] === 'string' && args[0].startsWith('Error occurred in handler for \'bus:')) return;
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

let vaultWindow: BrowserWindow | null;
let mainWindow: BrowserWindow | null;
let agentDbChangesPublisher: AgentDbChangesPublisher | null = null;

const clientPath = path.join(__dirname, 'client', 'index.html');

// --- Module instantiation + dependency wiring ---

const rendererBridge = new RendererBridge({
  getMainWindow: () => mainWindow,
});

const tabViewManager = new TabViewManager({
  getMainWindow: () => mainWindow,
  toggleCommandPalette: () => commandPalette.toggle(),
  dispatchRendererCustomEvent: (name, detail) => rendererBridge.dispatchRendererCustomEvent(name, detail),
  dispatchRendererWindowEvent: (name) => rendererBridge.dispatchRendererWindowEvent(name),
});

const commandPalette = new CommandPaletteManager({
  getMainWindow: () => mainWindow,
  getDataDir,
  rendererBridge,
  getTabViewManager: () => tabViewManager,
});

// --- IPC registration ---

registerStoreHandlers();
registerDialogSubscribers();

registerAgentToolsHandlers(getDataDir, {
  getTabs: () => tabViewManager.getTabsHandler(),
  openTab: (req) => tabViewManager.openTabHandler(req),
  closeTab: (req) => tabViewManager.closeTabHandler(req),
  selectTab: (req) => tabViewManager.selectTabHandler(req),
  reloadTab: (req) => tabViewManager.reloadTabHandler(req),
  captureTab: (req) => tabViewManager.captureTabById(req),
  getTabConsoleLogs: (req) => tabViewManager.getTabConsoleLogsById(req),
  execTabJs: (req) => tabViewManager.execTabJsById(req),
});

registerTabViewHandlers(tabViewManager);
registerCommandPaletteHandlers(commandPalette);

// --- DB changes publisher ---

function publishAgentDbChanges(event: AgentDbChangedEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app:agent-db-changed', event);
}

async function restartAgentDbChangesPublisher(): Promise<void> {
  agentDbChangesPublisher?.stop();
  agentDbChangesPublisher = new AgentDbChangesPublisher({
    getDataDir,
    onChanges: publishAgentDbChanges,
    onError: (error) => {
      console.error('[agent-runtime] failed to publish agent DB changes', error);
    },
  });
  await agentDbChangesPublisher.start();
}

// --- Data directory change listener ---

onDidChange('dataDir', async (newValue: unknown, oldValue: unknown) => {
  if (oldValue !== newValue) {
    const nextDataDir = typeof newValue === 'string' ? newValue : DEFAULT_DATA_DIR;
    agentDbChangesPublisher?.stop();
    commandPalette.destroy();
    tabViewManager.destroyAllTabViews();
    tabViewManager.clearTrackedViewWebContents();

    await ensureAgentRuntimeBootstrap(nextDataDir);
    await restartAgentDbChangesPublisher();
    mainWindow?.reload();
  }
});

// --- App window creation ---

async function createAppWindow(dataDir: string) {
  await ensureAgentRuntimeBootstrap(dataDir);

  mainWindow = new BrowserWindow({
    show: false,
    title: dataDir,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadURL('app://index.html');
  }

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

const createWindow = () => {
  const dataDir = storeGet('dataDir');
  if (typeof dataDir === 'string') return createAppWindow(dataDir)
  createAppWindow(DEFAULT_DATA_DIR)
}

// --- App lifecycle ---

app.on('ready', async () => {
  await ensureAgentRuntimeBootstrap(getDataDir());
  await restartAgentDbChangesPublisher();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault',
          click: () => {
            if (vaultWindow && !vaultWindow.isDestroyed()) {
              vaultWindow.show();
            } else {
              vaultWindow = createVaultWindow(mainWindow);
            }
          },
        },
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

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  const handleViewRequest = createViewProtocolHandler({ getDataDir, clientPath });
  protocol.handle('agentview', (request) => {
    return handleViewRequest(request);
  });

  createWindow()
});

app.on('web-contents-created', (event, webContents) => {
  tabViewManager.registerWebContentsTracking(event, webContents);
});

app.on('window-all-closed', () => {
  commandPalette.destroy();
  tabViewManager.destroyAllTabViews();
  tabViewManager.clearTrackedViewWebContents();
  if (process.platform !== 'darwin') {
    agentDbChangesPublisher?.stop();
    agentDbChangesPublisher = null;
    app.quit();
  }
});

app.on('before-quit', () => {
  agentDbChangesPublisher?.stop();
  agentDbChangesPublisher = null;
  commandPalette.destroy();
  tabViewManager.destroyAllTabViews();
  tabViewManager.clearTrackedViewWebContents();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
