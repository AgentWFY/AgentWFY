import { app, BaseWindow, dialog, Menu, nativeImage, protocol, net, webContents } from 'electron';
import { registerAppHandlers } from './ipc/app.js';
import { registerStoreHandlers, startFileWatcher, stopFileWatcher, onAnyChange, storeGet } from './ipc/store.js';
import { setFallbackStoreReader } from '#shared/settings/config.js';
import { registerViewHandlers } from './ipc/views.js';
import { registerDialogSubscribers } from './ipc/dialog.js';
import { registerSqlHandlers } from './ipc/sql.js';
import { registerPageHandlers } from './ipc/pages.js';
import { registerTabViewHandlers } from './ipc/tab-views.js';
import { registerCommandPaletteHandlers } from './command-palette/ipc.js';
import { registerTaskRunnerHandlers } from './ipc/tasks.js';
import { registerAgentHandlers } from './ipc/agents.js';
import { registerAgentSidebarHandlers } from './ipc/agent-sidebar.js';
import { registerConfirmationHandlers } from './confirmation/ipc.js';
import { registerProviderHandlers } from './ipc/providers.js';
import { registerRuntimeFunctionHandlers } from './ipc/runtime-functions.js';
import { registerAgentSessionHandlers, setupAgentChatPump } from './ipc/agent-sessions.js';
import { BLOB_HOST, readBlob } from './chat/message-blobs.js';
import { registerTraceHandlers } from './ipc/traces.js';
import { registerZenModeHandlers } from './ipc/zen-mode.js';
import { registerPreviewCursorHandlers } from './ipc/preview-cursor.js';
import { flushDesktopTraceWriters } from './runtime/desktop-runtime-registry.js';
import {
  showOpenAgentDialog,
  showInstallAgentFromFileDialog,
  isAgentDir,
  initAgent,
  createDefaultAgent,
} from './agent-manager.js';
import { windowManager, getPersistedAgentIds } from './window-manager.js';
import { stopBackupScheduler } from '#shared/backup-scheduler.js';
import { stopCleanupScheduler } from '#shared/cleanup-scheduler.js';
import { startAutoUpdater, stopAutoUpdater, checkForUpdates } from './auto-updater.js';
import { startGlobalConfigWatcher, stopGlobalConfigWatcher, onGlobalConfigChange } from '#shared/settings/global-config.js';
import { SystemConfigKeys } from '#shared/system-config/keys.js';
import { isShortcutKey } from './shortcuts/task-actions.js';
import { getAgentMeta } from './agent-meta.js';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';

const DIST_ROOT = path.join(import.meta.dirname, '..');
const PROJECT_ROOT = path.join(DIST_ROOT, '..');

async function devRebuild(): Promise<void> {
  if (app.isPackaged) return;
  const root = PROJECT_ROOT;
  const tsgo = path.join(root, 'vendor', 'tsgo', 'lib', process.platform === 'win32' ? 'tsgo.exe' : 'tsgo');
  const dist = path.join(root, 'dist');
  await new Promise<void>((resolve) => {
    execFile(tsgo, [], { cwd: root }, (err) => {
      if (err) console.error('[dev-rebuild] build failed:', err.message);
      resolve();
    });
  });
  try {
    const { inlinePreload } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'inline-preload.mjs')).href);
    inlinePreload(dist);
  } catch (err) {
    console.error('[dev-rebuild] preload inline failed:', err instanceof Error ? err.message : err);
  }
}

app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

if (process.env.AGENTWFY_HEADLESS && process.platform === 'darwin') {
  app.dock?.hide();
}

// Write main process logs to .dev.log when not packaged
if (!app.isPackaged) {
  const devLogStream = fs.createWriteStream(path.join(PROJECT_ROOT, '.dev.log'), { flags: 'w' });
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
const suppressedChannels = ['files:', 'sql:', 'tabs:', 'bus:', 'execJs:', 'plugin:', 'runtime-functions:'];
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
  }
]);

// `app://blob/<id>` — binaries lifted out of chat messages so they don't ride
// on every snapshot and streaming frame. See desktop/chat/message-blobs.ts.
const SAFE_MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function serveBlob(url: URL): Response {
  const id = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const blob = readBlob(id);
  if (!blob) return new Response(null, { status: 404 });
  return new Response(Buffer.from(blob.data, 'base64'), {
    headers: {
      // Agent-supplied, so don't hand it to the renderer unvalidated.
      'content-type': SAFE_MIME_TYPE.test(blob.mimeType) ? blob.mimeType : 'application/octet-stream',
      // Ids are content hashes — the bytes behind a URL never change.
      'cache-control': 'public, max-age=31536000, immutable',
      // These bytes are agent-authored and this is the `app:` scheme, where the
      // preload exposes window.ipc on protocol alone. Blobs are only ever
      // loaded as subresources (<img src>), never as documents — so refuse to
      // be sniffed into one, and neuter the document if something does load it.
      // Top-level navigation here is separately blocked in window-manager.ts.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    },
  });
}

function isBlobUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'app:' && parsed.hostname === BLOB_HOST;
  } catch {
    return false;
  }
}

// Blobs are agent-authored bytes and must stay subresources (an `<img src>` in
// the chat). Loaded as a *document* one becomes an `app:` page, and preload.cts
// gates `window.ipc` on protocol alone — so an agent that wrote a link to its
// own blob into a chat message would hand its own HTML the full IPC surface.
// Every webContents in the app shares that preload, so the guard is global
// rather than per-window. Nothing links here legitimately; refusing the
// navigation outright is correct, not merely defensive.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (isBlobUrl(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (isBlobUrl(event.url)) event.preventDefault();
  });
});

const clientPath = path.join(import.meta.dirname, 'renderer', 'index.html');

// --- IPC registration (global, routes via windowManager) ---

registerStoreHandlers();
setFallbackStoreReader(storeGet);
registerViewHandlers();
registerDialogSubscribers();

// Apply theme before window creation so titleBarOverlay picks up the right colors
windowManager.applyTheme();

const handleConfigChange = (key: string, newValue: unknown) => {
  if (key === SystemConfigKeys.theme) windowManager.applyTheme();
  if (key === SystemConfigKeys.showTabSource) windowManager.applyTrafficLightPosition();
  if (key === SystemConfigKeys.hideTrafficLights) windowManager.applyTrafficLightVisibility();
  if (isShortcutKey(key)) {
    windowManager.reloadShortcutsForAllAgents();
  }
  windowManager.broadcastSettingChanged(key, newValue);
};
onAnyChange(handleConfigChange);
onGlobalConfigChange(handleConfigChange);

registerSqlHandlers(
  (e) => windowManager.getBackendForSender(e.sender.id),
);
registerPageHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).pageTools,
  (e) => windowManager.getCacheRootForEvent(e),
  () => windowManager.getHeadlessPageCount(),
);
registerTabViewHandlers(
  (e) => windowManager.getContextForSender(e.sender.id).tabViewManager,
);
registerCommandPaletteHandlers(() => windowManager.getCommandPalette());
registerTaskRunnerHandlers(
  (e) => windowManager.getCacheRootForEvent(e),
  (e) => windowManager.getContextForSender(e.sender.id).shortcutManager,
  (e) => windowManager.getBackendForSender(e.sender.id),
);
registerRuntimeFunctionHandlers(
  (e) => windowManager.getBackendForSender(e.sender.id),
);
registerAgentHandlers(
  (e) => windowManager.getCacheRootForEvent(e),
  () => windowManager.getCommandPalette(),
);
registerConfirmationHandlers(() => windowManager.getConfirmation());
const reconnectSessionManager = async (e: Electron.IpcMainInvokeEvent) => {
  const ctx = windowManager.getLocalContextForSender(e.sender.id);
  // Tear down the old chat pump (which is bound to the old session manager)
  // and dispose the old manager.
  ctx.chatPump?.stop();
  ctx.chatPump = null;
  await ctx.sessionManager.disposeAll();
  // Create new session manager.
  const { AgentSessionManager } = await import('#shared/agent/session_manager.js');
  const { NodeFileStore } = await import('#shared/storage/node-file-store.js');
  const { getElectronNotificationHost } = await import('./runtime/hosts-electron.js');
  const agentIdForReconnect = ctx.agentId;
  const newMgr = new AgentSessionManager({
    runtimeRoot: ctx.runtimeRoot,
    store: new NodeFileStore(ctx.runtimeRoot),
    providerRegistry: ctx.providerRegistry,
    getJsRuntime: () => ctx.jsRuntime,
    busPublish: (topic, data) => ctx.eventBus.publish(topic, data),
    notificationHost: getElectronNotificationHost(),
  });
  ctx.sessionManager = newMgr;
  // Rebuild the chat pump so it subscribes to the new manager through
  // the chat controller.
  const rwc = windowManager.getRendererWebContents();
  if (rwc) {
    ctx.chatPump = setupAgentChatPump(
      ctx.chat, rwc, () => windowManager.getActiveAgentId() === agentIdForReconnect,
    );
  }
  newMgr.resetActive();
  return newMgr;
};
registerProviderHandlers(
  () => windowManager.getRendererWebContents() ?? undefined,
  (e) => windowManager.getBackendForSender(e.sender.id),
);
registerAgentSessionHandlers(
  reconnectSessionManager,
  (e) => windowManager.getBackendForSender(e.sender.id),
  (e) => windowManager.getContextForSender(e.sender.id).chat,
  (e) => windowManager.getContextForSender(e.sender.id).chatPump,
);
registerTraceHandlers((e) => windowManager.getBackendForSender(e.sender.id));

registerAppHandlers({
  devRebuild,
  getActiveAgentId: () => windowManager.getActiveAgentId(),
  getActiveHttpApiPort: () => windowManager.getActiveHttpApiPort(),
  getActiveCacheRoot: () => windowManager.getActiveCacheRoot(),
  getActiveBackend: () => windowManager.getActiveBackend(),
  getCacheRootForEvent: (e) => windowManager.getCacheRootForEvent(e),
});
registerAgentSidebarHandlers({
  getMainWindow: () => windowManager.getMainWindow(),
  getInstalledAgentsList: () => windowManager.getInstalledAgentsList(),
  addAgent: (agentId) => windowManager.addAgent(agentId),
  switchAgent: (agentId) => windowManager.switchAgent(agentId),
  removeAgent: (agentId) => windowManager.removeAgent(agentId),
  stopAgent: (agentId) => windowManager.stopAgent(agentId),
  reorderAgents: (fromIndex, toIndex) => windowManager.reorderAgents(fromIndex, toIndex),
});
registerZenModeHandlers({
  toggleZenMode: () => windowManager.toggleZenMode(),
  setZenMode: (value) => windowManager.setZenMode(value),
});
registerPreviewCursorHandlers({
  getPreviewCursor: () => windowManager.getPreviewCursor(),
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

function isPersistableAgentId(agentId: string): boolean {
  // We must read meta directly here: this is the bootstrap path that runs before
  // any agent context has been initialized, so ctx.mode is not yet available.
  return isAgentDir(agentId) || getAgentMeta(agentId).backend === 'remote';
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
      const persisted = getPersistedAgentIds().filter(r => isPersistableAgentId(r));
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
  const persisted = getPersistedAgentIds().filter(r => isPersistableAgentId(r));
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
    if (url.hostname === BLOB_HOST) return serveBlob(url);

    const p = decodeURIComponent(url.pathname);

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  startAutoUpdater();

  createInitialWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let forceQuit = false;
let quitDialogOpen = false;
let flushInProgress = false;
let flushComplete = false;

function doQuitCleanup() {
  stopFileWatcher();
  stopGlobalConfigWatcher();
  stopBackupScheduler();
  stopCleanupScheduler();
  stopAutoUpdater();
  windowManager.destroyAll();
}

// Drain buffered trace writes before the sync cleanup — disposeDesktopRuntime
// fires its own flush but doesn't await it, so without this the last few trace
// records (the ones most useful for post-mortem debugging) can be lost on exit.
async function flushThenCleanup() {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    await flushDesktopTraceWriters();
  } catch (err) {
    console.error('[quit] trace flush failed:', err);
  }
  flushComplete = true;
  doQuitCleanup();
  app.quit();
}

app.on('before-quit', (event) => {
  if (flushComplete) return;

  if (forceQuit) {
    event.preventDefault();
    void flushThenCleanup();
    return;
  }

  if (!windowManager.hasActiveWork()) {
    event.preventDefault();
    void flushThenCleanup();
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
