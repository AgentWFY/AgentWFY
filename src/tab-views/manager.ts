import { BrowserWindow, Menu, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import path from 'path';
import { isViewDocumentRequest, parseViewId } from '../protocol/view-document.js';

// --- Types & Constants ---

export interface ViewConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

export interface ViewRuntimeEntry {
  webContentsId: number
  webContents: WebContents
  viewId: string
  tabId: string | null
  ownerWindowId: number | null
  lastNavigationAt: number
  lastFocusedAt: number
  logs: ViewConsoleLogEntry[]
}

export interface TabViewState {
  tabId: string
  viewId: string
  currentSrc: string | null
  view: WebContentsView
  logs: ViewConsoleLogEntry[]
}

export type TabType = 'view' | 'file' | 'url'

interface TabViewBoundsPayload {
  x: number
  y: number
  width: number
  height: number
}

interface TabViewMountPayload {
  tabId: string
  viewId: string
  src: string
  bounds: TabViewBoundsPayload
  visible: boolean
  tabType?: TabType
}

interface TabViewSetBoundsPayload {
  tabId: string
  bounds: TabViewBoundsPayload
  visible: boolean
}

export interface TabViewDestroyPayload {
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

export const VIEW_LOG_BUFFER_MAX = 1000;
const VIEW_EXEC_DEFAULT_TIMEOUT_MS = 5000;
const VIEW_EXEC_MAX_TIMEOUT_MS = 120000;

export const WEB_CONTENTS_LOG_LEVEL_MAP: Record<string, string> = {
  debug: 'verbose',
  info: 'info',
  warning: 'warning',
  error: 'error',
};

export const GET_TABS_QUERY = `(() => {
  const tabsEl = document.querySelector('tl-tabs');
  if (!tabsEl) return { tabs: [] };
  const selectedTabId = typeof tabsEl.selectedTabId === 'string' ? tabsEl.selectedTabId : null;
  const tabList = Array.isArray(tabsEl.tabs) ? tabsEl.tabs : [];
  return {
    tabs: tabList.map((tab) => ({
      id: tab.id,
      title: tab.title || '',
      type: tab.type || 'view',
      target: tab.target ?? null,
      viewUpdatedAt: tab.viewUpdatedAt ?? null,
      viewChanged: Boolean(tab.viewChanged),
      pinned: Boolean(tab.pinned),
      selected: tab.id === selectedTabId,
    })),
  };
})()`;

// --- Input validation helpers ---

function normalizeTabViewNumber(value: unknown): number {
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

export function normalizeTabViewBounds(raw: unknown): Rectangle {
  const input = (raw && typeof raw === 'object') ? raw as Partial<TabViewBoundsPayload> : {};
  return {
    x: normalizeTabViewNumber(input.x),
    y: normalizeTabViewNumber(input.y),
    width: normalizeTabViewNumber(input.width),
    height: normalizeTabViewNumber(input.height),
  };
}

export function toNonEmptyString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string value');
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Expected a non-empty string value');
  }

  return normalized;
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

function resolveOwnerWindowId(webContents: WebContents): number | null {
  const hostWebContents = (webContents as WebContents & { hostWebContents?: WebContents }).hostWebContents;
  const owner = hostWebContents
    ? BrowserWindow.fromWebContents(hostWebContents)
    : BrowserWindow.fromWebContents(webContents);
  return owner?.id ?? null;
}

// --- TabViewManager ---

export interface TabViewManagerDeps {
  getMainWindow: () => BrowserWindow | null;
  toggleCommandPalette: () => void;
  dispatchRendererCustomEvent: (name: string, detail?: unknown) => void;
  dispatchRendererWindowEvent: (name: string) => void;
}

export class TabViewManager {
  private readonly tabViewsByTabId = new Map<string, TabViewState>();
  private readonly viewRuntimeEntries = new Map<number, ViewRuntimeEntry>();
  private readonly deps: TabViewManagerDeps;

  constructor(deps: TabViewManagerDeps) {
    this.deps = deps;
  }

  // --- Tab lifecycle ---

  createTabViewState(tabId: string, viewId: string, options?: { tabType?: TabType }): TabViewState {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable');
    }

    const isUrlTab = options?.tabType === 'url';

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: isUrlTab,
        backgroundThrottling: false,
      },
    });

    const state: TabViewState = {
      tabId,
      viewId,
      currentSrc: null,
      view,
      logs: [],
    };

    const viewWebContents = view.webContents;
    const updateFromNavigation = (url: string) => {
      this.updateTrackedViewWebContents(viewWebContents, url);
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
      this.deps.dispatchRendererCustomEvent('__tab-view-event', undefined);
      const win = this.deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('tabs:viewEvent', { tabId, type: 'did-start-loading' });
      }
    });

    viewWebContents.on('did-stop-loading', () => {
      const win = this.deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('tabs:viewEvent', { tabId, type: 'did-stop-loading' });
      }
    });

    viewWebContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      const win = this.deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('tabs:viewEvent', {
          tabId,
          type: 'did-fail-load',
          errorCode,
          errorDescription,
        });
      }
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
        this.deps.toggleCommandPalette();
        return;
      }

      if (key === 'i') {
        event.preventDefault();
        this.deps.dispatchRendererWindowEvent('agentwfy:toggle-agent-chat');
        return;
      }

      if (key === 'w') {
        event.preventDefault();
        this.deps.dispatchRendererWindowEvent('agentwfy:remove-current-tab');
        return;
      }

      if (key === 'r') {
        event.preventDefault();
        this.reloadTabView(tabId);
      }
    });

    viewWebContents.on('focus', () => {
      const entry = this.viewRuntimeEntries.get(viewWebContents.id);
      if (!entry) {
        return;
      }
      entry.ownerWindowId = resolveOwnerWindowId(viewWebContents);
      entry.lastFocusedAt = Date.now();
    });

    viewWebContents.on('console-message', (consoleEvent) => {
      state.logs.push({
        level: WEB_CONTENTS_LOG_LEVEL_MAP[consoleEvent.level] || 'info',
        message: consoleEvent.message,
        timestamp: Date.now(),
      });

      if (state.logs.length > VIEW_LOG_BUFFER_MAX) {
        state.logs.splice(0, state.logs.length - VIEW_LOG_BUFFER_MAX);
      }
    });

    viewWebContents.once('destroyed', () => {
      this.removeTrackedViewWebContents(viewWebContents.id);
      const existing = this.tabViewsByTabId.get(tabId);
      if (existing?.view === view) {
        this.tabViewsByTabId.delete(tabId);
      }
    });

    this.tabViewsByTabId.set(tabId, state);

    return state;
  }

  ensureTabViewState(tabId: string, viewId: string, options?: { tabType?: TabType }): TabViewState {
    const existing = this.tabViewsByTabId.get(tabId);
    if (existing) {
      existing.viewId = viewId;
      return existing;
    }

    return this.createTabViewState(tabId, viewId, options);
  }

  private attachTabViewToWindow(state: TabViewState): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    try {
      mainWindow.contentView.addChildView(state.view);
    } catch {
      // Ignore if already attached to the same parent view.
    }
  }

  private applyTabViewPlacement(state: TabViewState, bounds: Rectangle, visible: boolean): void {
    this.attachTabViewToWindow(state);

    const effectiveBounds = visible
      ? bounds
      : { x: 0, y: 0, width: 0, height: 0 };

    state.view.setBounds(effectiveBounds);
    state.view.setVisible(visible);
  }

  async mountTabView(payload: unknown): Promise<void> {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewMountPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    const viewId = toNonEmptyString(input.viewId);
    const src = toNonEmptyString(input.src);
    const visible = Boolean(input.visible);
    const bounds = normalizeTabViewBounds(input.bounds);
    const tabType = (input.tabType === 'view' || input.tabType === 'file' || input.tabType === 'url') ? input.tabType : undefined;
    const state = this.ensureTabViewState(tabId, viewId, { tabType });

    this.applyTabViewPlacement(state, bounds, visible);

    if (state.currentSrc === src) {
      return;
    }

    state.currentSrc = src;
    try {
      await state.view.webContents.loadURL(src);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'ERR_ABORTED' || (error as { errno?: number })?.errno === -3) {
        return;
      }
      throw error;
    }
  }

  setTabViewBounds(payload: unknown): void {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewSetBoundsPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    const state = this.tabViewsByTabId.get(tabId);
    if (!state) {
      return;
    }

    const visible = Boolean(input.visible);
    const bounds = normalizeTabViewBounds(input.bounds);
    this.applyTabViewPlacement(state, bounds, visible);
  }

  destroyTabView(tabId: string): void {
    const state = this.tabViewsByTabId.get(tabId);
    if (!state) {
      return;
    }

    this.tabViewsByTabId.delete(tabId);
    this.removeTrackedViewWebContents(state.view.webContents.id);

    const mainWindow = this.deps.getMainWindow();
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

  destroyAllTabViews(): void {
    const tabIds = Array.from(this.tabViewsByTabId.keys());
    for (const tabId of tabIds) {
      this.destroyTabView(tabId);
    }
  }

  reloadTabView(tabId: string): void {
    const state = this.tabViewsByTabId.get(tabId);
    if (!state) {
      return;
    }

    state.currentSrc = null;
    if (!state.view.webContents.isDestroyed()) {
      state.view.webContents.reload();
    }
  }

  reloadAllTabViews(): void {
    for (const [tabId] of this.tabViewsByTabId) {
      this.reloadTabView(tabId);
    }
  }

  reloadVisibleTabView(): void {
    for (const [tabId, state] of this.tabViewsByTabId) {
      const bounds = state.view.getBounds();
      if (bounds.width > 0 && bounds.height > 0) {
        this.reloadTabView(tabId);
        return;
      }
    }
  }

  // --- Tab resolution ---

  resolveTabViewState(tabId: string): TabViewState {
    const state = this.tabViewsByTabId.get(tabId);
    if (!state) {
      throw new Error(`No open tab found for tabId "${tabId}"`);
    }

    if (state.view.webContents.isDestroyed()) {
      throw new Error(`Tab "${tabId}" webContents is destroyed`);
    }

    return state;
  }

  // --- Tab handlers ---

  async getTabsHandler(): Promise<{ tabs: Array<Record<string, unknown>> }> {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { tabs: [] };
    }

    try {
      const result: unknown = await mainWindow.webContents.executeJavaScript(GET_TABS_QUERY, true);
      if (!result || typeof result !== 'object' || !Array.isArray((result as Record<string, unknown>).tabs)) {
        return { tabs: [] };
      }
      return result as { tabs: Array<Record<string, unknown>> };
    } catch (error) {
      console.warn('[agent-runtime] failed to read tabs from renderer', error);
      return { tabs: [] };
    }
  }

  async openTabHandler(request: { viewId?: string | number; filePath?: string; url?: string; title?: string }): Promise<void> {
    const type = request.url ? 'url' : request.filePath ? 'file' : 'view';
    this.deps.dispatchRendererCustomEvent('agentwfy:agent-open-tab', {
      type,
      viewId: request.viewId,
      filePath: request.filePath,
      url: request.url,
      title: request.title,
    });
  }

  async closeTabHandler(request: { tabId: string }): Promise<void> {
    this.deps.dispatchRendererCustomEvent('agentwfy:agent-close-tab', {
      tabId: request.tabId,
    });
  }

  async selectTabHandler(request: { tabId: string }): Promise<void> {
    this.deps.dispatchRendererCustomEvent('agentwfy:agent-select-tab', {
      tabId: request.tabId,
    });
  }

  async reloadTabHandler(request: { tabId: string }): Promise<void> {
    this.reloadTabView(request.tabId);
    this.deps.dispatchRendererCustomEvent('agentwfy:agent-clear-view-changed', {
      tabId: request.tabId,
    });
  }

  async captureTabById(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }> {
    const state = this.resolveTabViewState(request.tabId);
    const image = await state.view.webContents.capturePage();
    return {
      base64: image.toPNG().toString('base64'),
      mimeType: 'image/png',
    };
  }

  async getTabConsoleLogsById(request: {
    tabId: string
    since?: number
    limit?: number
  }): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    const state = this.resolveTabViewState(request.tabId);

    const since = typeof request.since === 'number' && Number.isFinite(request.since)
      ? request.since
      : undefined;
    const limit = typeof request.limit === 'number' && Number.isFinite(request.limit)
      ? Math.max(1, Math.floor(request.limit))
      : undefined;

    const filtered = typeof since === 'number'
      ? state.logs.filter((log) => log.timestamp > since)
      : state.logs.slice();

    if (typeof limit === 'number' && filtered.length > limit) {
      return filtered.slice(filtered.length - limit);
    }

    return filtered;
  }

  async execTabJsById(request: {
    tabId: string
    code: string
    timeoutMs?: number
  }): Promise<unknown> {
    const state = this.resolveTabViewState(request.tabId);
    if (typeof request.code !== 'string') {
      throw new Error('execTabJs requires code as a string');
    }

    const requestedTimeout = typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs)
      ? Math.floor(request.timeoutMs)
      : VIEW_EXEC_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(requestedTimeout, VIEW_EXEC_MAX_TIMEOUT_MS));

    return withTimeout(state.view.webContents.executeJavaScript(request.code, true), timeoutMs);
  }

  // --- Webview tracking ---

  parseTrackedViewFromUrl(urlString: string): { viewId: string; tabId: string | null } | null {
    if (typeof urlString !== 'string' || !urlString.startsWith('agentview://')) {
      return null;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      return null;
    }

    if (!isViewDocumentRequest(parsedUrl)) {
      return null;
    }

    let viewId: string;
    try {
      viewId = parseViewId(parsedUrl);
    } catch {
      return null;
    }

    const rawTabId = parsedUrl.searchParams.get('tabId');
    const tabId = typeof rawTabId === 'string' && rawTabId.trim().length > 0 ? rawTabId.trim() : null;
    return { viewId: String(viewId), tabId };
  }

  updateTrackedViewWebContents(webContents: WebContents, urlString: string): void {
    const tracked = this.parseTrackedViewFromUrl(urlString);
    if (!tracked) {
      this.removeTrackedViewWebContents(webContents.id);
      return;
    }

    const now = Date.now();
    const existing = this.viewRuntimeEntries.get(webContents.id);
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
      this.viewRuntimeEntries.set(webContents.id, entry);
      return;
    }

    existing.viewId = tracked.viewId;
    existing.tabId = tracked.tabId;
    existing.ownerWindowId = resolveOwnerWindowId(webContents);
    existing.lastNavigationAt = now;
  }

  private removeTrackedViewWebContents(webContentsId: number): void {
    this.viewRuntimeEntries.delete(webContentsId);
  }

  clearTrackedViewWebContents(): void {
    this.viewRuntimeEntries.clear();
  }

  registerWebContentsTracking(_event: Electron.Event, webContents: WebContents): void {
    if (webContents.getType() !== 'webview') {
      return;
    }

    const updateFromNavigation = (url: string) => {
      this.updateTrackedViewWebContents(webContents, url);
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
      const entry = this.viewRuntimeEntries.get(webContents.id);
      if (!entry) {
        return;
      }
      entry.ownerWindowId = resolveOwnerWindowId(webContents);
      entry.lastFocusedAt = Date.now();
    });

    webContents.on('console-message', (consoleEvent) => {
      const entry = this.viewRuntimeEntries.get(webContents.id);
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
      this.removeTrackedViewWebContents(webContents.id);
    });

    const initialUrl = webContents.getURL();
    if (initialUrl) {
      this.updateTrackedViewWebContents(webContents, initialUrl);
    }
  }

  // --- Context menu ---

  showNativeTabContextMenu(
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
}
