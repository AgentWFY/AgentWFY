import { BaseWindow, BrowserWindow, Menu, nativeTheme, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { isViewDocumentRequest, parseViewName } from '../protocol/view-document.js';
import { Channels } from '../ipc/channels.cjs';
import type { SendToRenderer } from '../ipc/schema.js';
import { resolveTimeout, formatTimeoutError } from '../runtime/timeout_utils.js';

// --- Types & Constants ---

export type TabDataType = 'view' | 'file' | 'url'

export interface TabData {
  id: string
  type: TabDataType
  title: string
  target: string
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

export interface TabViewEvent {
  tabId: string
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'
  errorCode?: number
  errorDescription?: string
}

interface ViewConsoleLogEntry {
  level: string
  message: string
  timestamp: number
}

interface ViewRuntimeEntry {
  webContentsId: number
  webContents: WebContents
  viewName: string
  tabId: string | null
  ownerWindowId: number | null
  lastNavigationAt: number
  lastFocusedAt: number
  logs: ViewConsoleLogEntry[]
}

interface TabViewState {
  tabId: string
  viewName: string
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

interface TabViewSetBoundsPayload {
  tabId: string
  bounds: TabViewBoundsPayload
  visible: boolean
}


interface TabContextMenuPayload {
  x: number
  y: number
  tabId?: string
}

type TabContextMenuAction = 'toggle-pin' | 'reload' | 'toggle-devtools' | null;

const VIEW_LOG_BUFFER_MAX = 1000;
const VIEW_EXEC_DEFAULT_TIMEOUT_MS = 5000;
const VIEW_EXEC_MAX_TIMEOUT_MS = 120000;
const FALLBACK_VIEW_WIDTH = 1280;
const FALLBACK_VIEW_HEIGHT = 720;
const WEB_CONTENTS_LOG_LEVEL_MAP: Record<string, string> = {
  debug: 'verbose',
  info: 'info',
  warning: 'warning',
  error: 'error',
};

const VALID_MODIFIERS = new Set<string>(['shift', 'control', 'alt', 'meta']);
const MOUSE_EVENT_TYPES = new Set<string>(['mouseDown', 'mouseUp', 'mouseMove']);
const KEY_EVENT_TYPES = new Set<string>(['keyDown', 'keyUp', 'char']);
const VALID_BUTTONS = new Set<string>(['left', 'middle', 'right']);
const INPUT_TYPE_ALIASES: Record<string, string> = {
  mousedown: 'mouseDown',
  mouseup: 'mouseUp',
  mousemove: 'mouseMove',
  mousewheel: 'mouseWheel',
  keydown: 'keyDown',
  keyup: 'keyUp',
};


function isAbortedLoadError(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ERR_ABORTED' || (error as { errno?: number })?.errno === -3;
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, wasDefault: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(formatTimeoutError('execTabJs', timeoutMs, wasDefault, VIEW_EXEC_MAX_TIMEOUT_MS)));
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
  sendToRenderer: SendToRenderer;
  focusMainRendererWindow: () => void;
  matchShortcut: (key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) => string | null;
  handleAction?: (action: string) => void;
  session: Electron.Session;
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

  createTabViewState(tabId: string, viewName: string, options?: { tabType?: TabType }): TabViewState {
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
        session: this.deps.session,
      },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff');

    const state: TabViewState = {
      tabId,
      viewName,
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
      this.deps.sendToRenderer(Channels.tabs.viewEvent, { tabId, type: 'did-start-loading' });
    });

    viewWebContents.on('did-stop-loading', () => {
      this.deps.sendToRenderer(Channels.tabs.viewEvent, { tabId, type: 'did-stop-loading' });
    });

    viewWebContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      this.deps.sendToRenderer(Channels.tabs.viewEvent, {
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

  ensureTabViewState(tabId: string, viewName: string, options?: { tabType?: TabType }): TabViewState {
    const existing = this.tabViewsByTabId.get(tabId);
    if (existing) {
      existing.viewName = viewName;
      return existing;
    }

    return this.createTabViewState(tabId, viewName, options);
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
      const mainWindow = this.deps.getMainWindow();
      const [w, h] = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : [FALLBACK_VIEW_WIDTH, FALLBACK_VIEW_HEIGHT];
      state.view.setBounds({ x: 0, y: 0, width: w, height: h });
    }

    state.view.setVisible(visible);
  }

  private buildTabSrc(type: TabDataType, target: string, tabId: string, params?: Record<string, string>): string {
    if (type === 'url') return target;

    const encodedTabId = encodeURIComponent(tabId);
    const rev = Date.now();
    let url: string;
    if (type === 'file') {
      url = `agentview://view/${encodeURIComponent(target)}?source=file&rev=${rev}&tabId=${encodedTabId}`;
    } else {
      url = `agentview://view/${encodeURIComponent(target)}?rev=${rev}&tabId=${encodedTabId}`;
    }
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
    }
    return url;
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

  /** Hide all tab views without detaching them from the window (used when switching agents).
   *  Views stay as children of contentView to avoid page reloads that detach/re-attach can trigger. */
  hideAllViews(): void {
    for (const state of this.tabViewsByTabId.values()) {
      state.view.setVisible(false);
    }
  }

  /** Restore tab views for the active agent and push state to the renderer. */
  showAllViews(): void {
    this.pushStateToRenderer();
  }

  reloadTabView(tabId: string): void {
    const state = this.tabViewsByTabId.get(tabId);
    if (!state) {
      return;
    }

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

  /** Resolve the tab view state AND wait for the page to finish loading. */
  private async resolveReadyTabViewState(tabId: string): Promise<TabViewState> {
    const state = this.resolveTabViewState(tabId);
    const wc = state.view.webContents;

    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wc.removeListener('did-stop-loading', done);
          wc.removeListener('destroyed', done);
          resolve();
        };
        const timer = setTimeout(done, VIEW_EXEC_MAX_TIMEOUT_MS);
        wc.once('did-stop-loading', done);
        wc.once('destroyed', done);
      });

      if (wc.isDestroyed()) {
        throw new Error(`Tab "${tabId}" webContents was destroyed while waiting for load`);
      }
    }

    return state;
  }

  // --- Tab handlers ---

  async getTabsHandler(): Promise<Array<Record<string, unknown>>> {
    return this.tabs.map((tab) => ({
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
    }));
  }

  async openTabHandler(request: { viewName?: string; filePath?: string; url?: string; title?: string; hidden?: boolean; params?: Record<string, string> }): Promise<{ tabId: string }> {
    const type: TabDataType = request.url ? 'url' : request.filePath ? 'file' : 'view';
    let target: string;
    if (type === 'url') {
      target = request.url!;
    } else if (type === 'file') {
      target = request.filePath!;
    } else {
      target = request.viewName!;
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

    // Create the WebContentsView and start loading immediately instead of
    // waiting for a renderer round-trip (which is gated by requestAnimationFrame
    // and gets severely throttled when the window is in the background).
    const state = this.ensureTabViewState(tabId, target, { tabType: type });
    const mainWindow = this.deps.getMainWindow();
    const [w, h] = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getContentSize()
      : [FALLBACK_VIEW_WIDTH, FALLBACK_VIEW_HEIGHT];
    this.applyTabViewPlacement(state, { x: 0, y: 0, width: w, height: h }, !isHidden);

    const src = this.buildTabSrc(type, target, tabId, request.params);
    state.view.webContents.loadURL(src).catch((error: unknown) => {
      if (!isAbortedLoadError(error)) {
        console.error('[tabs] openTab loadURL failed:', error);
      }
    });

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
    // Wait for the page to finish loading so callers know when the reload is complete.
    await this.resolveReadyTabViewState(request.tabId);
  }

  async captureTabById(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }> {
    const state = await this.resolveReadyTabViewState(request.tabId);

    // Non-selected views have setVisible(false) to save compositor resources.
    // Temporarily enable compositing behind all other views for the capture.
    const needsCompositing = state.tabId !== this.selectedTabId;
    if (needsCompositing) {
      const mainWindow = this.deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.contentView.addChildView(state.view, 0);
      }
      state.view.setVisible(true);
    }

    try {
      // Retry capturePage when the compositor hasn't produced a frame yet
      // (Chromium rejects with "UnknownVizError" before the first composite).
      const maxAttempts = 10;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const image = await state.view.webContents.capturePage();
          return {
            base64: image.toPNG().toString('base64'),
            mimeType: 'image/png',
          };
        } catch (err) {
          if (attempt === maxAttempts || !String(err).includes('UnknownVizError')) {
            throw err;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error('captureTab: failed after retries');
    } finally {
      if (needsCompositing) {
        state.view.setVisible(false);
      }
    }
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
    const state = await this.resolveReadyTabViewState(request.tabId);
    if (typeof request.code !== 'string') {
      throw new Error('execTabJs requires code as a string');
    }

    const { timeoutMs: requestedTimeout, wasDefault } = resolveTimeout(request.timeoutMs, VIEW_EXEC_DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(1, Math.min(requestedTimeout, VIEW_EXEC_MAX_TIMEOUT_MS));

    // Try compiling as `return (<code>)` first so bare expressions (e.g. "SYMBOLS.length")
    // evaluate to their value instead of silently becoming null. If that throws a
    // SyntaxError — e.g. the code uses statements, declarations, or its own `return` —
    // fall back to treating the code as an async function body (original behavior).
    // Detection runs inside the tab so parsing uses the same V8 as execution.
    // Coerce undefined → null so IPC serialization stays well-formed.
    const codeLiteral = JSON.stringify(request.code);
    const wrappedCode = `(async () => {
  const __code = ${codeLiteral};
  const __AsyncFn = (async function(){}).constructor;
  let __fn;
  try {
    __fn = new __AsyncFn('return (\\n' + __code + '\\n);');
  } catch (__err) {
    if (!(__err instanceof SyntaxError)) throw __err;
    __fn = new __AsyncFn(__code);
  }
  const __result = await __fn();
  return __result === undefined ? null : __result;
})()`;
    return withTimeout(state.view.webContents.executeJavaScript(wrappedCode, true), timeoutMs, wasDefault);
  }

  async sendInputById(request: {
    tabId: string
    type: string
    x?: number
    y?: number
    button?: string
    clickCount?: number
    deltaX?: number
    deltaY?: number
    keyCode?: string
    modifiers?: string[]
  }): Promise<void> {
    const state = await this.resolveReadyTabViewState(request.tabId);
    const wc = state.view.webContents;

    const type = INPUT_TYPE_ALIASES[request.type] ?? request.type;
    const modifiers = (request.modifiers || []).filter(m => VALID_MODIFIERS.has(m)) as
      Array<'shift' | 'control' | 'alt' | 'meta'>;
    const x = Math.round(request.x ?? 0);
    const y = Math.round(request.y ?? 0);
    const button = VALID_BUTTONS.has(request.button ?? '') ? request.button as 'left' | 'middle' | 'right' : undefined;

    if (type === 'click') {
      const clickCount = Math.max(1, Math.floor(request.clickCount ?? 1));
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: button ?? 'left', clickCount, modifiers });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: button ?? 'left', clickCount, modifiers });
      return;
    }

    if (type === 'mouseWheel') {
      wc.sendInputEvent({
        type: 'mouseWheel',
        x,
        y,
        deltaX: request.deltaX ?? 0,
        deltaY: request.deltaY ?? 0,
        modifiers,
      });
      return;
    }

    if (MOUSE_EVENT_TYPES.has(type)) {
      wc.sendInputEvent({
        type: type as 'mouseDown' | 'mouseUp' | 'mouseMove',
        x,
        y,
        button,
        clickCount: type === 'mouseDown' ? Math.max(1, Math.floor(request.clickCount ?? 1)) : undefined,
        modifiers,
      });
      return;
    }

    if (KEY_EVENT_TYPES.has(type)) {
      if (typeof request.keyCode !== 'string' || !request.keyCode) {
        throw new Error('keyCode is required for keyboard input events');
      }
      wc.sendInputEvent({
        type: type as 'keyDown' | 'keyUp' | 'char',
        keyCode: request.keyCode,
        modifiers,
      });
      return;
    }

    const supported = ['click', ...MOUSE_EVENT_TYPES, 'mouseWheel', ...KEY_EVENT_TYPES];
    throw new Error(`Unknown input event type: ${type}. Supported types: ${supported.join(', ')}`);
  }

  async inspectElementById(request: {
    tabId: string
    selector: string
  }): Promise<unknown> {
    if (typeof request.selector !== 'string' || !request.selector.trim()) {
      throw new Error('inspectElement requires a non-empty CSS selector');
    }

    const selectorLiteral = JSON.stringify(request.selector);
    const code = `
    const el = document.querySelector(${selectorLiteral});
    if (!el) return { found: false };

    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    return {
      found: true,
      tagName: el.tagName.toLowerCase(),
      textContent: (el.textContent || '').trim().slice(0, 500),
      attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
      classes: Array.from(el.classList),
      box: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      styles: {
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        position: cs.position,
        overflow: cs.overflow,
        zIndex: cs.zIndex,
        boxSizing: cs.boxSizing,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        textAlign: cs.textAlign,
        border: cs.border,
        borderCollapse: cs.borderCollapse,
        padding: cs.padding,
        margin: cs.margin,
        width: cs.width,
        height: cs.height,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth,
        minHeight: cs.minHeight,
        maxHeight: cs.maxHeight,
        cursor: cs.cursor,
        pointerEvents: cs.pointerEvents,
        userSelect: cs.userSelect,
        whiteSpace: cs.whiteSpace,
        textOverflow: cs.textOverflow,
        flexGrow: cs.flexGrow,
        flexShrink: cs.flexShrink,
        gridTemplateColumns: cs.gridTemplateColumns,
      },
      isVisible: cs.display !== 'none'
        && cs.visibility !== 'hidden'
        && parseFloat(cs.opacity) > 0
        && rect.width > 0
        && rect.height > 0,
      isInViewport: rect.top < window.innerHeight
        && rect.bottom > 0
        && rect.left < window.innerWidth
        && rect.right > 0,
      childCount: el.children.length,
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
    };`;

    return this.execTabJsById({ tabId: request.tabId, code });
  }

  // --- Webview tracking ---

  parseTrackedViewFromUrl(urlString: string): { viewName: string; tabId: string | null } | null {
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

    let viewName: string;
    try {
      viewName = parseViewName(parsedUrl);
    } catch {
      return null;
    }

    const rawTabId = parsedUrl.searchParams.get('tabId');
    const tabId = typeof rawTabId === 'string' && rawTabId.trim().length > 0 ? rawTabId.trim() : null;
    return { viewName, tabId };
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
        viewName: tracked.viewName,
        tabId: tracked.tabId,
        ownerWindowId: resolveOwnerWindowId(webContents),
        lastNavigationAt: now,
        lastFocusedAt: 0,
        logs: [],
      };
      this.viewRuntimeEntries.set(webContents.id, entry);
      return;
    }

    existing.viewName = tracked.viewName;
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

  markViewChanged(viewName: string): void {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.type !== 'view' || tab.target !== viewName) continue;
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

    const { x, y, tabId } = normalizeTabContextMenuPayload(payload);
    const tab = tabId ? this.tabs.find(t => t.id === tabId) : undefined;
    const pinned = tab?.pinned ?? false;
    const viewChanged = tab?.viewChanged ?? false;
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
