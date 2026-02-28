import { app, BrowserWindow, Menu, protocol, net, WebContents, WebContentsView, ipcMain, nativeTheme, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import createVaultWindow from './vault_window';
import ElectronStore from 'electron-store';
import { registerElectronStoreSubscribers } from './ipc/store';
import { registerDialogSubscribers } from './ipc/dialog';
import { registerAgentToolsHandlers } from './ipc/agent-tools';
import { registerBusHandlers } from './ipc/bus';
import { ensureViewsSchema, getViewById, listViews } from './services/views-repo';
import { buildViewDocument, parseAgentViewId } from './services/agentview-runtime';
import { AgentDbChangesPublisher, type AgentDbChangedEvent } from './services/agent-db-changes';
import { assertPathAllowed } from './security/path-policy';
import path from 'path';
import { pathToFileURL } from 'url';
import { createReadStream } from 'fs';
import { stat, mkdir } from 'fs/promises';

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

// Helper to get mime type
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// Converts Node stream to Web Stream
const nodeStreamToWeb = (nodeStream: any) => {
  nodeStream.pause();
  let closed = false;

  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: any) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on('error', (err: any) => controller.error(err));
      nodeStream.on('end', () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
    },
    pull() {
      if (!closed) nodeStream.resume();
    },
    cancel() {
      if (!closed) {
        closed = true;
        nodeStream.destroy();
      }
    }
  });
};

/**
 * Unified file server that handles both full loads and range requests (seeking)
 * without using net.fetch
 */
const serveFile = async (request: Request, absolutePath: string) => {
  try {
    const fileStat = await stat(absolutePath);
    const rangeHeader = request.headers.get('Range');

    // Default headers required for video playback
    const headers = new Headers([
      ['Content-Type', getMimeType(absolutePath)],
      ['Accept-Ranges', 'bytes'], // Tells the browser "We support Seeking"
      ['X-Content-Type-Options', 'nosniff'],
    ]);

    // 1. Handle Range Request (Seeking / Partial Content)
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      
      if (matches) {
        const startByte = matches[1] ? parseInt(matches[1], 10) : 0;
        const endByte = matches[2] ? parseInt(matches[2], 10) : fileStat.size - 1;

        // Validation
        if (startByte >= fileStat.size || endByte >= fileStat.size) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileStat.size}` }
          });
        }

        const chunksize = (endByte - startByte) + 1;
        const stream = createReadStream(absolutePath, { start: startByte, end: endByte });

        headers.set('Content-Range', `bytes ${startByte}-${endByte}/${fileStat.size}`);
        headers.set('Content-Length', chunksize.toString());

        return new Response(nodeStreamToWeb(stream), {
          status: 206, // Partial Content
          headers: headers,
        });
      }
    }

    // 2. Handle Full File Request (Initial Load)
    headers.set('Content-Length', fileStat.size.toString());
    
    const stream = createReadStream(absolutePath);
    return new Response(nodeStreamToWeb(stream), {
      status: 200, // OK
      headers: headers,
    });

  } catch (error) {
    console.error('File serving error:', error);
    return new Response('Not Found', { status: 404 });
  }
};

let vaultWindow: BrowserWindow | null;
let mainWindow: BrowserWindow | null;
let commandPaletteWindow: BrowserWindow | null = null;
let agentDbChangesPublisher: AgentDbChangesPublisher | null = null;

let clientPath = path.join(__dirname, 'client', 'index.html');

const DEFAULT_DATA_DIR = app.getPath('userData')
const AGENT_DIR_NAME = '.agentwfy';


function isPathInsideBase(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAgentViewAssetPath(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return null;
  }

  const normalizedRelativePath = relativePath.replace(/^\/+/, '').trim();
  if (normalizedRelativePath.length === 0) {
    return null;
  }

  // Restrict agentview://asset/* to bundled client assets only.
  if (!normalizedRelativePath.startsWith('assets/')) {
    return null;
  }

  const clientDir = path.dirname(clientPath);
  const absolutePath = path.resolve(clientDir, normalizedRelativePath);
  if (!isPathInsideBase(clientDir, absolutePath)) {
    return null;
  }

  return absolutePath;
}

function normalizeAgentViewPathname(pathname: string): string {
  const decoded = decodeURIComponent(pathname || '');
  return decoded.replace(/^\/+/, '').trim();
}

function isAgentViewDocumentRequest(url: URL): boolean {
  if (url.hostname !== 'view') {
    return false;
  }

  const normalizedPath = normalizeAgentViewPathname(url.pathname);
  if (!normalizedPath) {
    return false;
  }

  if (url.searchParams.has('tabId') || url.searchParams.has('rev') || url.searchParams.has('t')) {
    return true;
  }

  // Treat paths that look like files (contains "/" or extension) as data-dir assets.
  if (normalizedPath.includes('/') || normalizedPath.includes('.')) {
    return false;
  }

  return true;
}

async function resolveAgentViewDataPath(url: URL): Promise<string> {
  const normalizedPath = normalizeAgentViewPathname(url.pathname);
  if (!normalizedPath) {
    throw new Error('Missing file path');
  }

  return assertPathAllowed(getDataDir(), normalizedPath, { allowMissing: false });
}


const store = new ElectronStore();
registerElectronStoreSubscribers(store);
registerDialogSubscribers();

function getDataDir(): string {
  const dataDir = store.get('dataDir');
  return typeof dataDir === 'string' ? dataDir : app.getPath('userData');
}

function getAgentDir(dataDir: string): string {
  return path.join(dataDir, AGENT_DIR_NAME);
}

async function ensureAgentDir(dataDir: string): Promise<void> {
  const agentDir = getAgentDir(dataDir);
  try {
    await mkdir(agentDir, { recursive: true });
  } catch (error) {
    console.error(`[agent-runtime] failed to ensure private agent directory at ${agentDir}`, error);
  }
}

async function ensureAgentRuntimeBootstrap(dataDir: string): Promise<void> {
  await ensureAgentDir(dataDir);
  try {
    await ensureViewsSchema(dataDir);
  } catch (error) {
    console.error(`[agent-runtime] failed to initialize views schema for data dir ${dataDir}`, error);
  }
}

const VIEW_LOG_BUFFER_MAX = 1000;
const VIEW_EXEC_DEFAULT_TIMEOUT_MS = 5000;
const VIEW_EXEC_MAX_TIMEOUT_MS = 120000;

const WEB_CONTENTS_LOG_LEVEL_MAP: Record<number, string> = {
  0: 'verbose',
  1: 'info',
  2: 'warning',
  3: 'error',
};

const GET_TABS_QUERY = `(() => {
  const tabsEl = document.querySelector('tl-tabs');
  if (!tabsEl) return { tabs: [] };
  const selectedTabId = typeof tabsEl.selectedTabId === 'string' ? tabsEl.selectedTabId : null;
  const tabList = Array.isArray(tabsEl.tabs) ? tabsEl.tabs : [];
  return {
    tabs: tabList.map((tab) => ({
      id: tab.id,
      title: tab.title || '',
      viewId: tab.viewId ?? null,
      viewUpdatedAt: tab.viewUpdatedAt ?? null,
      viewChanged: Boolean(tab.viewChanged),
      pinned: Boolean(tab.pinned),
      selected: tab.id === selectedTabId,
    })),
  };
})()`;

interface ViewConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

interface ViewRuntimeEntry {
  webContentsId: number
  webContents: WebContents
  viewId: string
  tabId: string | null
  ownerWindowId: number | null
  lastNavigationAt: number
  lastFocusedAt: number
  logs: ViewConsoleLogEntry[]
}

const viewRuntimeEntries = new Map<number, ViewRuntimeEntry>();
const externalViewsByTabId = new Map<string, ExternalViewState>();

const EXTERNAL_VIEW_CHANNEL = {
  MOUNT: 'electronExternalView:mount',
  SET_BOUNDS: 'electronExternalView:setBounds',
  DESTROY: 'electronExternalView:destroy',
  EVENT: 'app:external-view-event',
} as const;

const TAB_CONTEXT_MENU_CHANNEL = 'app:tabs:context-menu';

const COMMAND_PALETTE_CHANNEL = {
  CLOSE: 'app:command-palette:close',
  LIST_ITEMS: 'app:command-palette:list-items',
  RUN_ACTION: 'app:command-palette:run-action',
  OPENED: 'app:command-palette:opened',
} as const;

interface ExternalViewBoundsPayload {
  x: number
  y: number
  width: number
  height: number
}

interface ExternalViewMountPayload {
  tabId: string
  viewId: string
  src: string
  bounds: ExternalViewBoundsPayload
  visible: boolean
}

interface ExternalViewSetBoundsPayload {
  tabId: string
  bounds: ExternalViewBoundsPayload
  visible: boolean
}

interface ExternalViewDestroyPayload {
  tabId: string
}

interface TabContextMenuPayload {
  x: number
  y: number
  pinned: boolean
  viewChanged?: boolean
  tabId?: string
}

type TabContextMenuAction = 'toggle-pin' | 'reload' | null;

interface ExternalViewState {
  tabId: string
  viewId: string
  currentSrc: string | null
  view: WebContentsView
}

type CommandPaletteAction =
  | {
    type: 'open-view'
    viewId: string
    title: string
    viewUpdatedAt: number | null
  }
  | {
    type: 'toggle-agent-chat'
  }
  | {
    type: 'close-current-tab'
  }
  | {
    type: 'reload-views'
  };

interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  group: 'Views' | 'Actions'
  action: CommandPaletteAction
}

function normalizeExternalViewNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeContextMenuCoordinate(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeTabContextMenuPayload(raw: unknown): TabContextMenuPayload {
  const input = raw && typeof raw === 'object' ? raw as Partial<TabContextMenuPayload> : {};
  return {
    x: normalizeContextMenuCoordinate(input.x),
    y: normalizeContextMenuCoordinate(input.y),
    pinned: Boolean(input.pinned),
    viewChanged: Boolean(input.viewChanged),
    tabId: typeof input.tabId === 'string' ? input.tabId : undefined,
  };
}

function normalizeExternalViewBounds(raw: unknown): Rectangle {
  const input = (raw && typeof raw === 'object') ? raw as Partial<ExternalViewBoundsPayload> : {};
  return {
    x: normalizeExternalViewNumber(input.x),
    y: normalizeExternalViewNumber(input.y),
    width: normalizeExternalViewNumber(input.width),
    height: normalizeExternalViewNumber(input.height),
  };
}

function toNonEmptyString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string value');
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Expected a non-empty string value');
  }

  return normalized;
}

function emitExternalViewEvent(
  tabId: string,
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load',
  detail?: { errorCode?: number; errorDescription?: string }
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(EXTERNAL_VIEW_CHANNEL.EVENT, {
    tabId,
    type,
    ...(detail || {}),
  });
}

function focusMainRendererWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    if (!mainWindow.isFocused()) {
      mainWindow.focus();
    }
    mainWindow.webContents.focus();
  } catch (error) {
    console.warn('[agent-runtime] failed to focus renderer window', error);
  }
}

function toSafeJsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function dispatchRendererCustomEvent(eventName: string, detail?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  focusMainRendererWindow();
  const serializedName = JSON.stringify(eventName);
  const eventInit = typeof detail === 'undefined'
    ? ''
    : `, { detail: ${toSafeJsonLiteral(detail)} }`;

  void mainWindow.webContents.executeJavaScript(`
    window.dispatchEvent(new CustomEvent(${serializedName}${eventInit}));
  `, true).catch((error) => {
    console.warn(`[agent-runtime] failed to dispatch renderer event ${eventName}`, error);
  });
}

function dispatchRendererWindowEvent(eventName: string): void {
  dispatchRendererCustomEvent(eventName);
}

function resolveCommandPaletteBounds(): Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { x: 0, y: 0, width: 720, height: 520 };
  }

  const bounds = mainWindow.getBounds();
  const width = Math.min(880, Math.max(540, Math.floor(bounds.width * 0.58)));
  const height = Math.min(640, Math.max(360, Math.floor(bounds.height * 0.62)));
  const x = bounds.x + Math.floor((bounds.width - width) / 2);
  const y = bounds.y + Math.max(40, Math.floor((bounds.height - height) * 0.2));
  return { x, y, width, height };
}

function syncCommandPaletteBounds(): void {
  if (!commandPaletteWindow || commandPaletteWindow.isDestroyed()) {
    return;
  }

  commandPaletteWindow.setBounds(resolveCommandPaletteBounds());
}

function hideNativeCommandPalette(options?: { focusMain?: boolean }): void {
  if (!commandPaletteWindow || commandPaletteWindow.isDestroyed() || !commandPaletteWindow.isVisible()) {
    if (options?.focusMain) {
      focusMainRendererWindow();
    }
    return;
  }

  commandPaletteWindow.hide();
  if (options?.focusMain !== false) {
    focusMainRendererWindow();
  }
}

function destroyNativeCommandPalette(): void {
  if (!commandPaletteWindow || commandPaletteWindow.isDestroyed()) {
    commandPaletteWindow = null;
    return;
  }

  commandPaletteWindow.destroy();
  commandPaletteWindow = null;
}

function ensureCommandPaletteWindow(): BrowserWindow {
  if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
    return commandPaletteWindow;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is unavailable');
  }

  commandPaletteWindow = new BrowserWindow({
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f0f0f0',
    webPreferences: {
      preload: path.join(__dirname, 'command_palette_preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  if (process.platform === 'darwin') {
    commandPaletteWindow.setAlwaysOnTop(true, 'floating');
    commandPaletteWindow.setWindowButtonVisibility(false);
  }



  commandPaletteWindow.on('blur', () => {
    setTimeout(() => {
      if (!commandPaletteWindow || commandPaletteWindow.isDestroyed()) {
        return;
      }
      if (commandPaletteWindow.isFocused()) {
        return;
      }
      hideNativeCommandPalette({ focusMain: true });
    }, 0);
  });

  commandPaletteWindow.on('closed', () => {
    commandPaletteWindow = null;
  });

  void commandPaletteWindow.loadURL(pathToFileURL(path.join(__dirname, 'command_palette.html')).toString())
    .catch((error) => {
      console.error('[command-palette] failed to load native command palette window', error);
    });

  return commandPaletteWindow;
}

function showNativeCommandPalette(): void {
  const paletteWindow = ensureCommandPaletteWindow();
  syncCommandPaletteBounds();
  paletteWindow.show();
  paletteWindow.moveTop();
  paletteWindow.focus();
  paletteWindow.webContents.focus();

  const focusSearchInput = () => {
    if (paletteWindow.isDestroyed()) {
      return;
    }

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
    `, true).catch((error) => {
      console.warn('[command-palette] failed to focus search input', error);
    });
  };

  setTimeout(focusSearchInput, 0);
  setTimeout(focusSearchInput, 80);

  const notifyOpened = () => {
    if (!paletteWindow.isDestroyed()) {
      paletteWindow.webContents.send(COMMAND_PALETTE_CHANNEL.OPENED);
    }
  };

  if (paletteWindow.webContents.isLoadingMainFrame()) {
    paletteWindow.webContents.once('did-finish-load', notifyOpened);
  } else {
    notifyOpened();
  }
}

function toggleNativeCommandPalette(): void {
  const paletteWindow = ensureCommandPaletteWindow();
  if (paletteWindow.isVisible()) {
    hideNativeCommandPalette({ focusMain: true });
    return;
  }

  showNativeCommandPalette();
}

async function buildCommandPaletteItems(): Promise<CommandPaletteItem[]> {
  const rows = await listViews(getDataDir());
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

  const actionItems: CommandPaletteItem[] = [
    {
      id: 'action:toggle-agent-chat',
      title: 'Toggle AI Panel',
      group: 'Actions',
      action: { type: 'toggle-agent-chat' },
    },
    {
      id: 'action:close-current-tab',
      title: 'Close Current Tab',
      group: 'Actions',
      action: { type: 'close-current-tab' },
    },
    {
      id: 'action:reload-views',
      title: 'Reload Views Catalog',
      group: 'Actions',
      action: { type: 'reload-views' },
    },
  ];

  return [...actionItems, ...viewItems];
}

async function runCommandPaletteAction(payload: unknown): Promise<void> {
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
      dispatchRendererCustomEvent('agentwfy:open-view', {
        viewId: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).viewId,
        title: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).title,
        viewUpdatedAt: (action as Extract<CommandPaletteAction, { type: 'open-view' }>).viewUpdatedAt ?? null,
      });
      break;

    case 'toggle-agent-chat':
      dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
      break;

    case 'close-current-tab':
      dispatchRendererWindowEvent('agentwfy:remove-current-tab');
      break;

    case 'reload-views': {
      const views = await listViews(getDataDir());
      dispatchRendererCustomEvent('agentwfy:views-loaded', {
        views: views.map((row) => ({
          title: row.name,
          viewId: row.id,
          viewUpdatedAt: row.updated_at ?? null,
        })),
      });
      reloadAllExternalViews();
      break;
    }

    default:
      throw new Error(`Unsupported command palette action type: ${type}`);
  }

  hideNativeCommandPalette({ focusMain: true });
}

function createExternalViewState(tabId: string, viewId: string): ExternalViewState {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is unavailable');
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });

  const state: ExternalViewState = {
    tabId,
    viewId,
    currentSrc: null,
    view,
  };

  const viewWebContents = view.webContents;
  const updateFromNavigation = (url: string) => {
    updateTrackedViewWebContents(viewWebContents, url);
  };

  viewWebContents.on('did-start-navigation', (_navEvent, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      updateFromNavigation(url);
    }
  });

  viewWebContents.on('did-navigate', (_navEvent, url) => {
    updateFromNavigation(url);
  });

  viewWebContents.on('did-navigate-in-page', (_navEvent, url, isMainFrame) => {
    if (isMainFrame) {
      updateFromNavigation(url);
    }
  });

  viewWebContents.on('did-start-loading', () => {
    emitExternalViewEvent(tabId, 'did-start-loading');
  });

  viewWebContents.on('did-stop-loading', () => {
    emitExternalViewEvent(tabId, 'did-stop-loading');
  });

  viewWebContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }

    emitExternalViewEvent(tabId, 'did-fail-load', {
      errorCode,
      errorDescription,
    });
  });

  viewWebContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (!key || input.alt || input.isAutoRepeat) {
      return;
    }

    const hasCommandModifier = process.platform === 'darwin' ? input.meta : input.control;
    if (!hasCommandModifier || input.shift) {
      return;
    }

    if (key === 'k') {
      event.preventDefault();
      toggleNativeCommandPalette();
      return;
    }

    if (key === 'i') {
      event.preventDefault();
      dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
      return;
    }

    if (key === 'w') {
      event.preventDefault();
      dispatchRendererWindowEvent('agentwfy:remove-current-tab');
      return;
    }

    if (key === 'r') {
      event.preventDefault();
      reloadExternalView(tabId);
    }
  });

  viewWebContents.on('focus', () => {
    const entry = viewRuntimeEntries.get(viewWebContents.id);
    if (!entry) {
      return;
    }
    entry.ownerWindowId = resolveOwnerWindowId(viewWebContents);
    entry.lastFocusedAt = Date.now();
  });

  viewWebContents.on('console-message', (consoleEvent) => {
    const entry = viewRuntimeEntries.get(viewWebContents.id);
    if (!entry) {
      return;
    }

    entry.logs.push({
      level: WEB_CONTENTS_LOG_LEVEL_MAP[consoleEvent.level] || 'info',
      message: consoleEvent.message,
      timestamp: Date.now(),
    });

    if (entry.logs.length > VIEW_LOG_BUFFER_MAX) {
      entry.logs.splice(0, entry.logs.length - VIEW_LOG_BUFFER_MAX);
    }
  });

  viewWebContents.once('destroyed', () => {
    removeTrackedViewWebContents(viewWebContents.id);
    const existing = externalViewsByTabId.get(tabId);
    if (existing?.view === view) {
      externalViewsByTabId.delete(tabId);
    }
  });

  externalViewsByTabId.set(tabId, state);
  return state;
}

function ensureExternalViewState(tabId: string, viewId: string): ExternalViewState {
  const existing = externalViewsByTabId.get(tabId);
  if (existing) {
    existing.viewId = viewId;
    return existing;
  }

  return createExternalViewState(tabId, viewId);
}

function attachExternalViewToWindow(state: ExternalViewState): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.contentView.addChildView(state.view);
  } catch {
    // Ignore if already attached to the same parent view.
  }
}

function applyExternalViewPlacement(state: ExternalViewState, bounds: Rectangle, visible: boolean): void {
  attachExternalViewToWindow(state);

  const effectiveBounds = visible
    ? bounds
    : { x: 0, y: 0, width: 0, height: 0 };

  state.view.setBounds(effectiveBounds);
  state.view.setVisible(visible);
}

async function mountExternalView(payload: unknown): Promise<void> {
  const input = payload && typeof payload === 'object' ? payload as Partial<ExternalViewMountPayload> : {};
  const tabId = toNonEmptyString(input.tabId);
  const viewId = toNonEmptyString(input.viewId);
  const src = toNonEmptyString(input.src);
  const visible = Boolean(input.visible);
  const bounds = normalizeExternalViewBounds(input.bounds);
  const state = ensureExternalViewState(tabId, viewId);

  applyExternalViewPlacement(state, bounds, visible);

  if (state.currentSrc === src) {
    return;
  }

  state.currentSrc = src;
  try {
    await state.view.webContents.loadURL(src);
  } catch (error: any) {
    if (error?.code === 'ERR_ABORTED' || error?.errno === -3) {
      return;
    }
    throw error;
  }
}

function setExternalViewBounds(payload: unknown): void {
  const input = payload && typeof payload === 'object' ? payload as Partial<ExternalViewSetBoundsPayload> : {};
  const tabId = toNonEmptyString(input.tabId);
  const state = externalViewsByTabId.get(tabId);
  if (!state) {
    return;
  }

  const visible = Boolean(input.visible);
  const bounds = normalizeExternalViewBounds(input.bounds);
  applyExternalViewPlacement(state, bounds, visible);
}

function destroyExternalView(tabId: string): void {
  const state = externalViewsByTabId.get(tabId);
  if (!state) {
    return;
  }

  externalViewsByTabId.delete(tabId);
  removeTrackedViewWebContents(state.view.webContents.id);

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.contentView.removeChildView(state.view);
    } catch {
      // Ignore if it is already detached.
    }
  }

  if (!state.view.webContents.isDestroyed()) {
    const webContentsWithDestroy = state.view.webContents as WebContents & { destroy?: () => void };
    if (typeof webContentsWithDestroy.destroy === 'function') {
      webContentsWithDestroy.destroy();
    } else {
      state.view.webContents.close();
    }
  }
}

function destroyAllExternalViews(): void {
  const tabIds = Array.from(externalViewsByTabId.keys());
  for (const tabId of tabIds) {
    destroyExternalView(tabId);
  }
}

function reloadExternalView(tabId: string): void {
  const state = externalViewsByTabId.get(tabId);
  if (!state) {
    return;
  }

  state.currentSrc = null;
  if (!state.view.webContents.isDestroyed()) {
    state.view.webContents.reload();
  }
}

function reloadAllExternalViews(): void {
  for (const [tabId] of externalViewsByTabId) {
    reloadExternalView(tabId);
  }
}

function reloadVisibleExternalView(): void {
  for (const [tabId, state] of externalViewsByTabId) {
    const bounds = state.view.getBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      reloadExternalView(tabId);
      return;
    }
  }
}

function showNativeTabContextMenu(
  event: IpcMainInvokeEvent,
  payload: unknown,
): Promise<TabContextMenuAction> {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!ownerWindow || ownerWindow.isDestroyed()) {
    return Promise.resolve(null);
  }

  const { x, y, pinned, viewChanged, tabId } = normalizeTabContextMenuPayload(payload);
  let selectedAction: TabContextMenuAction = null;

  const template: MenuItemConstructorOptions[] = [];

  if (viewChanged && tabId) {
    template.push({
      label: 'Reload',
      click: () => {
        selectedAction = 'reload';
      },
    });
  }

  template.push({
    label: pinned ? 'Unpin Tab' : 'Pin Tab',
    click: () => {
      selectedAction = 'toggle-pin';
    },
  });

  const menu = Menu.buildFromTemplate(template);
  return new Promise<TabContextMenuAction>((resolve) => {
    try {
      menu.popup({
        window: ownerWindow,
        x,
        y,
        callback: () => resolve(selectedAction),
      });
    } catch {
      resolve(null);
    }
  });
}

function parseTrackedViewFromUrl(urlString: string): { viewId: string; tabId: string | null } | null {
  if (typeof urlString !== 'string' || !urlString.startsWith('agentview://')) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return null;
  }

  if (!isAgentViewDocumentRequest(parsedUrl)) {
    return null;
  }

  let viewId: string;
  try {
    viewId = parseAgentViewId(parsedUrl);
  } catch {
    return null;
  }

  const rawTabId = parsedUrl.searchParams.get('tabId');
  const tabId = typeof rawTabId === 'string' && rawTabId.trim().length > 0 ? rawTabId.trim() : null;
  return { viewId: String(viewId), tabId };
}

function resolveOwnerWindowId(webContents: WebContents): number | null {
  const hostWebContents = (webContents as any).hostWebContents as WebContents | undefined;
  const owner = hostWebContents
    ? BrowserWindow.fromWebContents(hostWebContents)
    : BrowserWindow.fromWebContents(webContents);
  return owner?.id ?? null;
}

function removeTrackedViewWebContents(webContentsId: number): void {
  viewRuntimeEntries.delete(webContentsId);
}

function clearTrackedViewWebContents(): void {
  viewRuntimeEntries.clear();
}

function updateTrackedViewWebContents(webContents: WebContents, urlString: string): void {
  const tracked = parseTrackedViewFromUrl(urlString);
  if (!tracked) {
    removeTrackedViewWebContents(webContents.id);
    return;
  }

  const now = Date.now();
  const existing = viewRuntimeEntries.get(webContents.id);
  if (!existing) {
    const entry: ViewRuntimeEntry = {
      webContentsId: webContents.id,
      webContents,
      viewId: tracked.viewId,
      tabId: tracked.tabId,
      ownerWindowId: resolveOwnerWindowId(webContents),
      lastNavigationAt: now,
      lastFocusedAt: 0,
      logs: [],
    };
    viewRuntimeEntries.set(webContents.id, entry);
    return;
  }

  existing.viewId = tracked.viewId;
  existing.tabId = tracked.tabId;
  existing.ownerWindowId = resolveOwnerWindowId(webContents);
  existing.lastNavigationAt = now;
}

app.on('web-contents-created', (_event, webContents) => {
  if (webContents.getType() !== 'webview') {
    return;
  }

  const updateFromNavigation = (url: string) => {
    updateTrackedViewWebContents(webContents, url);
  };

  webContents.on('did-start-navigation', (_navEvent, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      updateFromNavigation(url);
    }
  });

  webContents.on('did-navigate', (_navEvent, url) => {
    updateFromNavigation(url);
  });

  webContents.on('did-navigate-in-page', (_navEvent, url, isMainFrame) => {
    if (isMainFrame) {
      updateFromNavigation(url);
    }
  });

  webContents.on('focus', () => {
    const entry = viewRuntimeEntries.get(webContents.id);
    if (!entry) {
      return;
    }
    entry.ownerWindowId = resolveOwnerWindowId(webContents);
    entry.lastFocusedAt = Date.now();
  });

  webContents.on('console-message', (consoleEvent) => {
    const entry = viewRuntimeEntries.get(webContents.id);
    if (!entry) {
      return;
    }

    entry.logs.push({
      level: WEB_CONTENTS_LOG_LEVEL_MAP[consoleEvent.level] || 'info',
      message: consoleEvent.message,
      timestamp: Date.now(),
    });

    if (entry.logs.length > VIEW_LOG_BUFFER_MAX) {
      entry.logs.splice(0, entry.logs.length - VIEW_LOG_BUFFER_MAX);
    }
  });

  webContents.once('destroyed', () => {
    removeTrackedViewWebContents(webContents.id);
  });

  const initialUrl = webContents.getURL();
  if (initialUrl) {
    updateTrackedViewWebContents(webContents, initialUrl);
  }
});

function resolveViewRuntimeEntryByTabId(tabId: string): ViewRuntimeEntry {
  const state = externalViewsByTabId.get(tabId);
  if (!state) {
    throw new Error(`No open tab found for tabId "${tabId}"`);
  }

  const webContentsId = state.view.webContents.id;
  if (state.view.webContents.isDestroyed()) {
    throw new Error(`Tab "${tabId}" webContents is destroyed`);
  }

  const entry = viewRuntimeEntries.get(webContentsId);
  if (!entry) {
    throw new Error(`No view runtime entry found for tabId "${tabId}"`);
  }

  return entry;
}

async function getTabsHandler(): Promise<{ tabs: Array<any> }> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { tabs: [] };
  }

  try {
    const result = await mainWindow.webContents.executeJavaScript(GET_TABS_QUERY, true);
    if (!result || typeof result !== 'object' || !Array.isArray((result as any).tabs)) {
      return { tabs: [] };
    }
    return result as { tabs: Array<any> };
  } catch (error) {
    console.warn('[agent-runtime] failed to read tabs from renderer', error);
    return { tabs: [] };
  }
}

async function openTabHandler(request: { viewId: string | number; title?: string }): Promise<void> {
  dispatchRendererCustomEvent('agentwfy:agent-open-tab', {
    viewId: request.viewId,
    title: request.title,
  });
}

async function closeTabHandler(request: { tabId: string }): Promise<void> {
  dispatchRendererCustomEvent('agentwfy:agent-close-tab', {
    tabId: request.tabId,
  });
}

async function selectTabHandler(request: { tabId: string }): Promise<void> {
  dispatchRendererCustomEvent('agentwfy:agent-select-tab', {
    tabId: request.tabId,
  });
}

async function reloadTabHandler(request: { tabId: string }): Promise<void> {
  reloadExternalView(request.tabId);
  dispatchRendererCustomEvent('agentwfy:agent-clear-view-changed', {
    tabId: request.tabId,
  });
}

async function captureTabById(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }> {
  const entry = resolveViewRuntimeEntryByTabId(request.tabId);
  const image = await entry.webContents.capturePage();
  return {
    base64: image.toPNG().toString('base64'),
    mimeType: 'image/png',
  };
}

async function getTabConsoleLogsById(request: {
  tabId: string
  since?: number
  limit?: number
}): Promise<Array<{ level: string; message: string; timestamp: number }>> {
  const entry = resolveViewRuntimeEntryByTabId(request.tabId);

  const since = typeof request.since === 'number' && Number.isFinite(request.since)
    ? request.since
    : undefined;
  const limit = typeof request.limit === 'number' && Number.isFinite(request.limit)
    ? Math.max(1, Math.floor(request.limit))
    : undefined;

  const filtered = typeof since === 'number'
    ? entry.logs.filter((log) => log.timestamp > since)
    : entry.logs.slice();

  if (typeof limit === 'number' && filtered.length > limit) {
    return filtered.slice(filtered.length - limit);
  }

  return filtered;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`View JavaScript execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function execTabJsById(request: {
  tabId: string
  code: string
  timeoutMs?: number
}): Promise<any> {
  const entry = resolveViewRuntimeEntryByTabId(request.tabId);
  if (typeof request.code !== 'string') {
    throw new Error('execTabJs requires code as a string');
  }

  const requestedTimeout = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs)
    ? Math.floor(request.timeoutMs)
    : VIEW_EXEC_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(requestedTimeout, VIEW_EXEC_MAX_TIMEOUT_MS));

  return withTimeout(entry.webContents.executeJavaScript(request.code, true), timeoutMs);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toHtmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleAgentViewRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === 'asset') {
    const assetPath = resolveAgentViewAssetPath(decodeURIComponent(url.pathname || ''));
    if (!assetPath) {
      return new Response('Asset not found', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    return net.fetch(pathToFileURL(assetPath).toString());
  }

  if (url.hostname === 'file' || (url.hostname === 'view' && !isAgentViewDocumentRequest(url))) {
    try {
      const absolutePath = await resolveAgentViewDataPath(url);
      return serveFile(request, absolutePath);
    } catch {
      return new Response('Asset not found', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  if (url.hostname !== 'view') {
    return new Response('Unsupported agentview route', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  let viewId: string;
  try {
    viewId = parseAgentViewId(url);
  } catch (error: any) {
    return toHtmlResponse(400, `<pre>${escapeHtml(error?.message || 'Invalid agent view URL')}</pre>`);
  }

  const dataDir = getDataDir();
  let record;
  try {
    record = await getViewById(dataDir, viewId);
  } catch (error: any) {
    console.error('[agentview] failed to read view from agent DB', error);
    return toHtmlResponse(500, `<pre>${escapeHtml(error?.message || 'Failed to load view')}</pre>`);
  }

  if (!record) {
    return toHtmlResponse(404, `<pre>View not found: ${escapeHtml(viewId)}</pre>`);
  }

  const html = buildViewDocument(record.content);
  return toHtmlResponse(200, html);
}

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

registerAgentToolsHandlers(getDataDir, {
  getTabs: getTabsHandler,
  openTab: openTabHandler,
  closeTab: closeTabHandler,
  selectTab: selectTabHandler,
  reloadTab: reloadTabHandler,
  captureTab: captureTabById,
  getTabConsoleLogs: getTabConsoleLogsById,
  execTabJs: execTabJsById,
});

ipcMain.handle(EXTERNAL_VIEW_CHANNEL.MOUNT, async (_event, payload: unknown) => {
  await mountExternalView(payload);
});

ipcMain.handle(EXTERNAL_VIEW_CHANNEL.SET_BOUNDS, async (_event, payload: unknown) => {
  setExternalViewBounds(payload);
});

ipcMain.handle(EXTERNAL_VIEW_CHANNEL.DESTROY, async (_event, payload: unknown) => {
  const input = payload && typeof payload === 'object' ? payload as Partial<ExternalViewDestroyPayload> : {};
  const tabId = toNonEmptyString(input.tabId);
  destroyExternalView(tabId);
});

ipcMain.handle(TAB_CONTEXT_MENU_CHANNEL, async (event, payload: unknown) => {
  return showNativeTabContextMenu(event, payload);
});

ipcMain.handle(COMMAND_PALETTE_CHANNEL.CLOSE, async () => {
  hideNativeCommandPalette({ focusMain: true });
});

ipcMain.handle(COMMAND_PALETTE_CHANNEL.LIST_ITEMS, async () => {
  return buildCommandPaletteItems();
});

ipcMain.handle(COMMAND_PALETTE_CHANNEL.RUN_ACTION, async (_event, payload: unknown) => {
  await runCommandPaletteAction(payload);
});

store.onDidChange('dataDir', async (newValue, oldValue) => {
  if (oldValue !== newValue) {
    const nextDataDir = typeof newValue === 'string' ? newValue : DEFAULT_DATA_DIR;
    agentDbChangesPublisher?.stop();
    destroyNativeCommandPalette();
    destroyAllExternalViews();
    clearTrackedViewWebContents();

    await ensureAgentRuntimeBootstrap(nextDataDir);
    await restartAgentDbChangesPublisher();
    mainWindow?.reload();
  }
});

async function createAppWindow(dataDir: string) {
  await ensureAgentRuntimeBootstrap(dataDir);

  // Create the browser window.
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
    destroyNativeCommandPalette();
    destroyAllExternalViews();
  });

  mainWindow.on('move', () => {
    syncCommandPaletteBounds();
  });

  mainWindow.on('resize', () => {
    syncCommandPaletteBounds();
  });

  registerBusHandlers(mainWindow);

  mainWindow.maximize();

  mainWindow.webContents.on('did-start-loading', () => {
    destroyNativeCommandPalette();
    destroyAllExternalViews();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  console.log('VITE_DEV_SERVER_URL:', devServerUrl);
  if (devServerUrl) {
    console.log('Loading from dev server:', devServerUrl);
    mainWindow.loadURL(devServerUrl);
  } else {
    console.log('Loading from app:// protocol');
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
      toggleNativeCommandPalette();
      return;
    }

    if (!input.shift && key === 'i') {
      event.preventDefault();
      dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
      return;
    }

    if (!input.shift && key === 'w') {
      event.preventDefault();
      dispatchRendererWindowEvent('agentwfy:remove-current-tab');
      return;
    }

    if (!input.shift && key === 'r') {
      event.preventDefault();
      reloadVisibleExternalView();
    }
  });
}

const createWindow = () => {
  const dataDir = store.get('dataDir');
  if (typeof dataDir === 'string') return createAppWindow(dataDir)
  createAppWindow(DEFAULT_DATA_DIR)
}

app.on('ready', async () => {
  await ensureAgentRuntimeBootstrap(getDataDir());
  await restartAgentDbChangesPublisher();
  const template: any[] = [
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
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ]
          : [
              { role: 'close' }
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

  protocol.handle('agentview', (request) => {
    return handleAgentViewRequest(request);
  });

  createWindow()
});

app.on('window-all-closed', () => {
  destroyNativeCommandPalette();
  destroyAllExternalViews();
  clearTrackedViewWebContents();
  if (process.platform !== 'darwin') {
    agentDbChangesPublisher?.stop();
    agentDbChangesPublisher = null;
    app.quit();
  }
});

app.on('before-quit', () => {
  agentDbChangesPublisher?.stop();
  agentDbChangesPublisher = null;
  destroyNativeCommandPalette();
  destroyAllExternalViews();
  clearTrackedViewWebContents();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
