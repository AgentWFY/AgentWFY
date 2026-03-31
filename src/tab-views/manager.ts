import { BaseWindow, BrowserWindow, Menu, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { isViewDocumentRequest, parseViewId } from '../protocol/view-document.js';
import { Channels } from '../ipc/channels.js';

// --- Types & Constants ---

export type TabDataType = 'view' | 'file' | 'url'

export interface TabData {
  id: string
  type: TabDataType
  title: string
  target: string | number
  viewUpdatedAt?: number | null
  viewChanged: boolean
  pinned: boolean
  hidden: boolean
  params?: Record<string, string>
}

export interface TabState {
  tabs: TabData[]
  selectedTabId: string | null
}

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

interface TabViewState {
  tabId: string
  viewId: string
  currentSrc: string | null
  view: WebContentsView
  logs: ViewConsoleLogEntry[]
}

type TabType = TabDataType

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

type TabContextMenuAction = 'toggle-pin' | 'reload' | 'toggle-devtools' | null;

const VIEW_LOG_BUFFER_MAX = 1000;
const VIEW_EXEC_DEFAULT_TIMEOUT_MS = 5000;
const VIEW_EXEC_MAX_TIMEOUT_MS = 120000;
const FALLBACK_VIEW_WIDTH = 1280;
const FALLBACK_VIEW_HEIGHT = 720;
const IS_DARWIN = process.platform === 'darwin';

const WEB_CONTENTS_LOG_LEVEL_MAP: Record<string, string> = {
  debug: 'verbose',
  info: 'info',
  warning: 'warning',
  error: 'error',
};


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

function normalizeTabViewBounds(raw: unknown): Rectangle {
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

interface TabViewManagerDeps {
  getMainWindow: () => BaseWindow | null;
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  focusMainRendererWindow: () => void;
  dispatchRendererCustomEvent: (name: string, detail?: unknown) => void;
  matchShortcut: (key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) => string | null;
  handleAction?: (action: string) => void;
  agentHash?: string;
  registerSender?: (webContentsId: number) => void;
  unregisterSender?: (webContentsId: number) => void;
}

export class TabViewManager {
  private readonly tabViewsByTabId = new Map<string, TabViewState>();
  private readonly viewRuntimeEntries = new Map<number, ViewRuntimeEntry>();
  private readonly deps: TabViewManagerDeps;
  private tabs: TabData[] = [];
  private selectedTabId: string | null = null;

  constructor(deps: TabViewManagerDeps) {
    this.deps = deps;
  }

  private generateTabId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private pushStateToRenderer(): void {
    this.deps.sendToRenderer(Channels.tabs.stateChanged, {
      tabs: this.tabs,
      selectedTabId: this.selectedTabId,
    });
  }

  getState(): TabState {
    return { tabs: this.tabs, selectedTabId: this.selectedTabId };
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
      this.deps.sendToRenderer('tabs:viewEvent', { tabId, type: 'did-start-loading' });
    });

    viewWebContents.on('did-stop-loading', () => {
      this.deps.sendToRenderer('tabs:viewEvent', { tabId, type: 'did-stop-loading' });
    });

    viewWebContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      this.deps.sendToRenderer('tabs:viewEvent', {
        tabId,
        type: 'did-fail-load',
        errorCode,
        errorDescription,
      });
    });

    viewWebContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      if (!key || input.isAutoRepeat) return;

      const action = this.deps.matchShortcut(key, !!input.meta, !!input.control, !!input.shift, !!input.alt);
      if (!action) return;

      event.preventDefault();
      this.deps.focusMainRendererWindow();
      this.deps.handleAction?.(action);
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
      this.deps.unregisterSender?.(viewWebContents.id);
      const existing = this.tabViewsByTabId.get(tabId);
      if (existing?.view === view) {
        this.tabViewsByTabId.delete(tabId);
      }
    });

    this.deps.registerSender?.(viewWebContents.id);
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

    if (visible) {
      state.view.setBounds(bounds);
    } else {
      // Keep real dimensions so the WebContents renders at a proper viewport
      // (CSS layouts, media queries, capturePage all depend on non-zero bounds).
      // setVisible(false) removes the view from the compositor — no visual or input side effects.
      const mainWindow = this.deps.getMainWindow();
      const [w, h] = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : [FALLBACK_VIEW_WIDTH, FALLBACK_VIEW_HEIGHT];
      state.view.setBounds({ x: 0, y: 0, width: w, height: h });
    }

    state.view.setVisible(visible);
  }

  private rewriteAgentViewUrl(src: string): string {
    const hash = this.deps.agentHash;
    if (!hash) return src;

    // Rewrite agentview://view/... → agentview://a{hash}.view/...
    // Rewrite agentview://file/... → agentview://a{hash}.file/...
    if (src.startsWith('agentview://view/')) {
      return src.replace('agentview://view/', `agentview://a${hash}.view/`);
    }
    if (src.startsWith('agentview://file/')) {
      return src.replace('agentview://file/', `agentview://a${hash}.file/`);
    }
    return src;
  }

  async mountTabView(payload: unknown): Promise<void> {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewMountPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    const viewId = toNonEmptyString(input.viewId);
    const rawSrc = toNonEmptyString(input.src);
    const src = this.rewriteAgentViewUrl(rawSrc);
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
    this.tabs = [];
    this.selectedTabId = null;
  }

  /** Detach all tab views from the window without destroying them (used when switching agents). */
  hideAllViews(): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    for (const state of this.tabViewsByTabId.values()) {
      if (state.view.webContents.isLoading()) {
        state.view.webContents.stop();
      }
      state.view.setVisible(false);
      try {
        mainWindow.contentView.removeChildView(state.view);
      } catch {
        // Already detached
      }
    }
  }

  /** Re-attach tab views to the window and restore visibility for the selected tab. */
  showAllViews(): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    for (const state of this.tabViewsByTabId.values()) {
      try {
        mainWindow.contentView.addChildView(state.view);
      } catch {
        // Already attached
      }
    }
    // Push current state to renderer so it re-mounts views with correct bounds
    this.pushStateToRenderer();
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

  toggleDevTools(tabId: string): void {
    const state = this.tabViewsByTabId.get(tabId);
    if (!state || state.view.webContents.isDestroyed()) {
      return;
    }
    state.view.webContents.toggleDevTools();
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
    return {
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title || '',
        type: tab.type || 'view',
        target: tab.target ?? null,
        viewUpdatedAt: tab.viewUpdatedAt ?? null,
        viewChanged: Boolean(tab.viewChanged),
        pinned: Boolean(tab.pinned),
        hidden: Boolean(tab.hidden),
        selected: tab.id === this.selectedTabId,
        params: tab.params || null,
      })),
    };
  }

  async openTabHandler(request: { viewId?: string | number; filePath?: string; url?: string; title?: string; hidden?: boolean; params?: Record<string, string> }): Promise<{ tabId: string }> {
    const type: TabDataType = request.url ? 'url' : request.filePath ? 'file' : 'view';
    let target: string | number;
    if (type === 'url') {
      target = request.url!;
    } else if (type === 'file') {
      target = request.filePath!;
    } else {
      target = request.viewId!;
    }

    const tabId = this.generateTabId();
    const isHidden = Boolean(request.hidden);
    const tab: TabData = {
      id: tabId,
      type,
      title: request.title || (type === 'url' ? 'Web Page' : type === 'file' ? 'File View' : 'Agent View'),
      target,
      viewUpdatedAt: null,
      viewChanged: false,
      pinned: false,
      hidden: isHidden,
      params: request.params,
    };
    this.tabs = [...this.tabs, tab];
    if (!isHidden) {
      this.selectedTabId = tabId;
    }
    this.pushStateToRenderer();
    return { tabId };
  }

  async closeTabHandler(request: { tabId: string }): Promise<void> {
    const tab = this.tabs.find(t => t.id === request.tabId);
    if (!tab || tab.pinned) return;

    this.tabs = this.tabs.filter(t => t.id !== request.tabId);
    this.destroyTabView(request.tabId);

    if (this.selectedTabId === request.tabId) {
      const visible = this.tabs.filter(t => !t.hidden);
      const last = visible[visible.length - 1];
      this.selectedTabId = last?.id || null;
    }
    this.pushStateToRenderer();
  }

  async selectTabHandler(request: { tabId: string }): Promise<void> {
    const tab = this.tabs.find(t => t.id === request.tabId);
    if (!tab || this.selectedTabId === request.tabId) return;
    this.selectedTabId = request.tabId;
    this.pushStateToRenderer();
  }

  async reloadTabHandler(request: { tabId: string }): Promise<void> {
    const tab = this.tabs.find(t => t.id === request.tabId);
    if (!tab) return;
    tab.viewChanged = false;
    this.reloadTabView(request.tabId);
    this.pushStateToRenderer();
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

    // isViewDocumentRequest checks hostname — works with both 'view' and 'a{hash}.view'
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

  // --- Tab state mutations ---

  markViewChanged(viewId: string | number): void {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.type !== 'view' || tab.target != viewId) continue;
      tab.viewChanged = true;
      changed = true;
    }
    if (changed) {
      this.pushStateToRenderer();
    }
  }

  togglePin(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    // Reorder: pinned tabs first, preserve relative order within each group
    const pinned = this.tabs.filter(t => t.pinned);
    const unpinned = this.tabs.filter(t => !t.pinned);
    this.tabs = [...pinned, ...unpinned];
    this.pushStateToRenderer();
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.tabs.length) return;
    if (toIndex < 0 || toIndex >= this.tabs.length) return;

    const pinnedEnd = this.tabs.filter(t => t.pinned && !t.hidden).length;
    const fromPinned = fromIndex < pinnedEnd;
    const toPinned = toIndex < pinnedEnd;
    if (fromPinned !== toPinned) return;

    const newTabs = [...this.tabs];
    const [tab] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, tab);
    this.tabs = newTabs;
    this.pushStateToRenderer();
  }

  revealTab(tabId: string): void {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.hidden) return;
    tab.hidden = false;
    this.selectedTabId = tabId;
    this.pushStateToRenderer();
  }

  closeCurrentTab(): void {
    if (!this.selectedTabId) return;
    this.closeTabHandler({ tabId: this.selectedTabId });
  }

  reloadCurrentTab(): void {
    if (!this.selectedTabId) return;
    this.reloadTabHandler({ tabId: this.selectedTabId });
  }

  /** Switch to the Nth visible tab (0-based index). */
  switchToTabByIndex(index: number): void {
    const visible = this.tabs.filter(t => !t.hidden);
    if (index < 0 || index >= visible.length) return;
    const tab = visible[index];
    if (tab.id === this.selectedTabId) return;
    this.selectedTabId = tab.id;
    this.pushStateToRenderer();
  }

  /** Switch to the next visible tab, wrapping around. */
  nextTab(): void {
    const visible = this.tabs.filter(t => !t.hidden);
    if (visible.length <= 1) return;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % visible.length;
    this.selectedTabId = visible[nextIdx].id;
    this.pushStateToRenderer();
  }

  /** Switch to the previous visible tab, wrapping around. */
  previousTab(): void {
    const visible = this.tabs.filter(t => !t.hidden);
    if (visible.length <= 1) return;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const prevIdx = currentIdx <= 0 ? visible.length - 1 : currentIdx - 1;
    this.selectedTabId = visible[prevIdx].id;
    this.pushStateToRenderer();
  }

  // --- Context menu ---

  showNativeTabContextMenu(
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<TabContextMenuAction> {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? this.deps.getMainWindow();
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
          this.reloadTabHandler({ tabId: tabId! });
        },
      });
    }

    template.push({
      label: pinned ? 'Unpin Tab' : 'Pin Tab',
      click: () => {
        selectedAction = 'toggle-pin';
        if (tabId) this.togglePin(tabId);
      },
    });

    if (tabId) {
      template.push({
        label: 'Toggle DevTools',
        click: () => {
          selectedAction = 'toggle-devtools';
          this.toggleDevTools(tabId!);
        },
      });
    }

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
