import { BaseWindow, BrowserWindow, Menu, nativeTheme, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { getViewByName } from '#shared/db/views.js';
import { agentHostname } from './protocol/agent-hostname.js';
import { Channels } from './ipc/channels.cjs';
import type { SendToRenderer } from './ipc/schema.js';
import {
  IdleCloseScheduler,
  resolvePageCloseAfterIdleMs,
} from '#shared/page/idle-close.js';
import { normalizePageViewportInput, resolvePageViewport } from '#shared/page/page-viewport.js';
import type {
  PageCloseAfterIdleMs,
  PageSource,
  PageViewport,
  PageViewportInput,
} from '#shared/page/types.js';
import {
  PAGE_JS_MAX_TIMEOUT_MS,
  buildPageExecutionCode,
  resolvePageJsTimeout,
  withPageJsTimeout,
} from '#shared/page/page-js.js';
import {
  PAGE_KEY_EVENT_TYPES,
  PAGE_MOUSE_EVENT_TYPES,
  normalizePageInput,
} from '#shared/page/page-input.js';
import { buildInspectElementCode } from '#shared/page/element-inspection.js';
import {
  CAPTURE_OFFSCREEN_OFFSET,
  FALLBACK_VIEW_HEIGHT,
  FALLBACK_VIEW_WIDTH,
  DesktopPageLayout,
  ZERO_BOUNDS,
} from './page/desktop-page-layout.js';
import { DesktopPageDebugger } from './page/desktop-page-debugger.js';
import { DesktopTabPresenter } from './page/desktop-tab-presenter.js';
import type {
  TabContextMenuAction,
  TabContextMenuPayload,
  TabData,
  TabDataType,
  TabState,
  TabType,
  TabViewBoundsPayload,
  TabViewSetBoundsPayload,
  TabViewState,
} from './page/desktop-page-types.js';
export type {
  TabContextMenuAction,
  TabData,
  TabDataType,
  TabState,
  TabViewEvent,
} from './page/desktop-page-types.js';

// --- Types & Constants ---

const VIEW_LOG_BUFFER_MAX = 1000;
const CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS = 1000;
const CAPTURE_CDP_TIMEOUT_MS = 3000;
const WEB_CONTENTS_LOG_LEVEL_MAP: Record<string, string> = {
  debug: 'verbose',
  info: 'info',
  warning: 'warning',
  error: 'error',
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// --- TabViewManager ---

interface TabViewManagerDeps {
  getMainWindow: () => BaseWindow | null;
  sendToRenderer: SendToRenderer;
  focusMainRendererWindow: () => void;
  matchShortcut: (key: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) => string | null;
  handleAction?: (action: string) => void;
  agentId: string;
  session: Electron.Session;
  registerSender?: (webContentsId: number) => void;
  unregisterSender?: (webContentsId: number) => void;
  // Views that must stay above the selected tab in the window's child
  // stack (command palette, confirmation dialog, preview cursor).
  // Invoked once per bringToFront; should be cheap.
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
  cacheRoot: string;
}

export class TabViewManager {
  private readonly tabViewsByTabId = new Map<string, TabViewState>();
  private readonly presenter: DesktopTabPresenter;
  private readonly layout: DesktopPageLayout;
  private readonly pageDebugger: DesktopPageDebugger;
  private readonly headlessIdleClose: IdleCloseScheduler<TabData>;
  private readonly deps: TabViewManagerDeps;

  constructor(deps: TabViewManagerDeps) {
    this.deps = deps;
    this.presenter = new DesktopTabPresenter({
      onStateChanged: (state) => {
        this.deps.sendToRenderer(Channels.tabs.stateChanged, state);
      },
    });
    this.layout = new DesktopPageLayout({
      getMainWindow: this.deps.getMainWindow,
      getOverlayViews: this.deps.getOverlayViews,
      getSelectedTabId: () => this.presenter.getSelectedTabId(),
      getTabById: (tabId) => this.tabById(tabId),
      getTabViewState: (tabId) => this.tabViewsByTabId.get(tabId),
      listTabViewStates: () => this.tabViewsByTabId.values(),
    });
    this.pageDebugger = new DesktopPageDebugger({
      resolveTabViewState: (tabId) => this.resolveTabViewState(tabId),
      resolveReadyTabViewState: (tabId) => this.resolveReadyTabViewState(tabId),
    });
    this.headlessIdleClose = new IdleCloseScheduler<TabData>({
      getEntry: (tabId) => {
        const tab = this.tabById(tabId);
        return tab?.headless ? tab : null;
      },
      closeEntry: (tabId) => this.closeTabHandler({ tabId }),
      onAutoCloseError: (tabId, err) => {
        console.warn(`[tabs] failed to auto-close idle headless tab "${tabId}":`, err);
      },
    });
  }

  private generateTabId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private pushStateToRenderer(): void {
    this.presenter.pushState();
  }

  getState(): TabState {
    return this.presenter.getState();
  }

  getTabData(tabId: string): TabData | null {
    return this.presenter.getTabData(tabId);
  }

  // Diagnostic snapshot of main-process tab state — per-tab bounds and
  // z-index directly from the BaseWindow's child list, which isn't
  // reachable from the renderer. Used by `preview --inspect tabs`.
  describeState(): {
    selectedTabId: string | null;
    selectedBounds: Rectangle | null;
    totalChildren: number;
    tabs: Array<{
      tabId: string;
      viewName: string;
      bounds: Rectangle;
      zIndex: number;
      visible: boolean;
      isSelected: boolean;
    }>;
  } {
    return this.layout.describeState();
  }

  // --- Tab lifecycle ---

  createTabViewState(tabId: string, viewName: string, options?: { tabType?: TabType }): TabViewState {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable');
    }

    const isUrlTab = options?.tabType === 'url';

    // The preload exposes window.agentwfy only when location.hostname matches
    // this exact host. Passing it via additionalArguments lets the preload
    // verify identity without an IPC roundtrip, and keeps the runtime
    // un-exposed if a spoofed *.views.agentwfy.local name ever resolves
    // through the user's DNS/mDNS/hosts.
    const expectedAgentHost = agentHostname(this.deps.agentId);
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: isUrlTab,
        backgroundThrottling: false,
        session: this.deps.session,
        additionalArguments: [`--agent-host=${expectedAgentHost}`],
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
      this.clearHeadlessIdleTimer(tabId);
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

  private applyTabViewPlacement(state: TabViewState, bounds: Rectangle, visible: boolean): void {
    this.layout.applyTabViewPlacement(state, bounds, visible);
  }

  private defaultContentBounds(): Rectangle {
    return this.layout.defaultContentBounds();
  }

  private tabById(tabId: string): TabData | undefined {
    return this.presenter.tabById(tabId);
  }

  private clearHeadlessIdleTimer(tabId: string): void {
    this.headlessIdleClose.clear(tabId);
  }

  private scheduleHeadlessIdleClose(tabId: string): void {
    this.headlessIdleClose.schedule(tabId);
  }

  touchTab(tabId: string): void {
    this.headlessIdleClose.touch(tabId);
  }

  private async resolveViewUpdatedAt(viewName: string): Promise<number | null> {
    try {
      const view = await getViewByName(this.deps.cacheRoot, viewName);
      return view?.updated_at ?? null;
    } catch (error: unknown) {
      console.warn(`[tabs] failed to read view metadata for "${viewName}":`, error);
      return null;
    }
  }

  private buildTabSrc(type: TabDataType, target: string, tabId: string, params?: Record<string, string>): string {
    if (type === 'url') return target;

    const encodedPageId = encodeURIComponent(tabId);
    const rev = Date.now();
    const host = agentHostname(this.deps.agentId);
    let url: string;
    if (type === 'file') {
      url = `https://${host}/view/${encodeURIComponent(target)}?source=file&rev=${rev}&pageId=${encodedPageId}`;
    } else {
      url = `https://${host}/view/${encodeURIComponent(target)}?rev=${rev}&pageId=${encodedPageId}`;
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

    this.clearHeadlessIdleTimer(tabId);
    this.cleanupDebuggerForTab(tabId);

    this.tabViewsByTabId.delete(tabId);

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
    this.presenter.clear();
  }

  // --- Debugger (Chrome DevTools Protocol) ---

  private applyHeadlessViewport(state: TabViewState, viewport: PageViewport): void {
    this.pageDebugger.applyHeadlessViewport(state, viewport);
  }

  private cleanupDebuggerForTab(tabId: string): void {
    this.pageDebugger.cleanupForTab(tabId);
  }

  async tabDebuggerSendById(request: {
    tabId: string;
    method: string;
    params?: unknown;
    sessionId?: string;
  }): Promise<unknown> {
    return this.pageDebugger.send(request);
  }

  tabDebuggerSubscribeById(request: {
    tabId: string;
    subscriptionId: string;
    events: string[];
  }): void {
    this.pageDebugger.subscribe(request);
  }

  async tabDebuggerPollById(request: {
    subscriptionId: string;
    maxBatch?: number;
    maxWaitMs?: number;
  }): Promise<{ events: Array<{ method: string; params: unknown; sessionId?: string }>; dropped: number; closed: boolean }> {
    return this.pageDebugger.poll(request);
  }

  tabDebuggerUnsubscribeById(subscriptionId: string): void {
    this.pageDebugger.unsubscribe(subscriptionId);
  }

  tabDebuggerDetachById(tabId: string): void {
    this.pageDebugger.detach(tabId);
  }

  // Brings this agent's selected tab above other agents' views on a switch.
  activateViews(): void {
    this.layout.activateViews();
    this.pushStateToRenderer();
  }

  // Inverse of activateViews. Called on the outgoing agent during a switch
  // so its views can't leak through when the incoming agent has no selected
  // tab on top (e.g. user just closed the last tab). Views stay attached
  // and setVisible(true) so captureTab keeps working for non-selected tabs.
  deactivateViews(): void {
    this.layout.deactivateViews();
  }

  // Directly shrink/restore every tab view in response to main-process
  // signals (zen mode, window hidden, etc.) that the renderer's
  // ResizeObserver/MutationObserver chain won't pick up — zen mode
  // removes the tab area from the box tree by an ancestor display:none,
  // which per spec doesn't fire ResizeObserver.
  setAllTabsCollapsed(collapsed: boolean): void {
    this.layout.setAllTabsCollapsed(collapsed);
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
        const timer = setTimeout(done, PAGE_JS_MAX_TIMEOUT_MS);
        wc.once('did-stop-loading', done);
        wc.once('destroyed', done);
      });

      if (wc.isDestroyed()) {
        throw new Error(`Tab "${tabId}" webContents was destroyed while waiting for load`);
      }
    }

    return state;
  }

  async waitForTabReady(tabId: string): Promise<void> {
    await this.resolveReadyTabViewState(tabId);
  }

  // --- Page-backed tab handlers ---

  async getTabsHandler(): Promise<TabData[]> {
    return this.presenter.listTabsForRuntime();
  }

  async getCurrentTabHandler(): Promise<TabData | null> {
    return this.presenter.currentTabForRuntime();
  }

  async openPageView(request: {
    pageId?: string;
    source: PageSource;
    title?: string;
    headless?: boolean;
    viewport?: PageViewportInput;
    width?: number;
    height?: number;
    closeAfterIdleMs?: PageCloseAfterIdleMs;
    params?: Record<string, string>;
    select?: boolean;
  }): Promise<{ pageId: string }> {
    const type: TabDataType = request.source.type === 'url'
      ? 'url'
      : request.source.type === 'file' ? 'file' : 'view';
    let target: string;
    if (type === 'url') {
      target = request.source.type === 'url' ? request.source.url : '';
      // A scheme-less URL makes loadURL reject with ERR_INVALID_URL after the
      // page is already attached and selected, leaving a zombie page that
      // occludes the previous one and hangs runPageJs/devtools. Validate up
      // front so callers get a synchronous error instead.
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        const looksLikePath = target.startsWith('/') || target.startsWith('./') || target.startsWith('file/');
        const hint = looksLikePath ? ' Did you mean to pass source.type "file" instead of "url"?' : '';
        throw new Error(`openPage source url must be absolute with a scheme (got ${JSON.stringify(target)}).${hint}`);
      }
      // An unknown scheme (`view://`, `agent://`, …) parses fine but loadURL
      // rejects with ERR_UNKNOWN_URL_SCHEME asynchronously — the catch on
      // loadURL below merely logs it, so the agent sees a blank page with no
      // error. Reject up front with a hint pointing at the right field.
      const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:']);
      if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
        const hint = parsed.protocol === 'view:'
          ? ' Did you mean to pass source.type "view" instead of "url"?'
          : '';
        throw new Error(`openPage source url scheme "${parsed.protocol}" is not supported (got ${JSON.stringify(target)}). Use http(s): or file:.${hint}`);
      }
    } else if (type === 'file') {
      target = request.source.type === 'file' ? request.source.path : '';
    } else {
      target = request.source.type === 'view' ? request.source.name : '';
    }

    const tabId = request.pageId ?? this.generateTabId();
    const isHeadless = Boolean(request.headless);
    const shouldSelect = !isHeadless && request.select !== false;
    const viewport = isHeadless ? resolvePageViewport(normalizePageViewportInput(request)) : null;
    const now = Date.now();
    const closeAfterIdleMs = isHeadless ? resolvePageCloseAfterIdleMs(request.closeAfterIdleMs) : null;
    const expiresAt = typeof closeAfterIdleMs === 'number' ? now + closeAfterIdleMs : null;
    const viewUpdatedAt = type === 'view' ? await this.resolveViewUpdatedAt(target) : null;
    const tab: TabData = {
      id: tabId,
      tabId,
      type,
      title: request.title || (type === 'url' ? 'Web Page' : type === 'file' ? 'File View' : 'Agent View'),
      target,
      viewUpdatedAt,
      viewChanged: false,
      pinned: false,
      headless: isHeadless,
      viewport,
      selected: false,
      params: request.params ?? null,
      openedAt: now,
      lastUsedAt: isHeadless ? now : undefined,
      closeAfterIdleMs,
      expiresAt,
    };
    this.presenter.addTab(tab, { select: shouldSelect });

    // Create the WebContentsView and start loading immediately instead of
    // waiting for a renderer round-trip (which is gated by requestAnimationFrame
    // and gets severely throttled when the window is in the background).
    const state = this.ensureTabViewState(tabId, target, { tabType: type });
    // Use last-known content bounds as the placeholder; full-window bounds
    // here would fully occlude the renderer's WebContentsView, and Windows
    // Chromium pauses RAF for occluded contents — the renderer would then
    // never run scheduleBoundsSync to report the correct rect.
    this.applyTabViewPlacement(
      state,
      shouldSelect ? this.layout.getSelectedBounds() ?? this.defaultContentBounds() : ZERO_BOUNDS,
      shouldSelect,
    );

    const src = this.buildTabSrc(type, target, tabId, request.params);
    state.view.webContents.loadURL(src).catch((error: unknown) => {
      if (!isAbortedLoadError(error)) {
        console.error('[tabs] openPage loadURL failed:', error);
      }
    });

    if (isHeadless && viewport) {
      this.applyHeadlessViewport(state, viewport);
      this.scheduleHeadlessIdleClose(tabId);
    }

    this.pushStateToRenderer();
    return { pageId: tabId };
  }

  async closeTabHandler(request: { tabId: string; force?: boolean }): Promise<void> {
    const result = this.presenter.closeTab(request.tabId, { force: request.force });
    if (!result.closed) return;

    this.clearHeadlessIdleTimer(request.tabId);
    this.destroyTabView(request.tabId);

    if (result.wasSelected) {
      // Promote the new selection to the top of z-order with full bounds.
      // Non-selected tabs sit at 0x0 bounds after the renderer reports them
      // not-visible, so without this the tab that was 2nd-from-top (also
      // 0x0) stays on top and any older full-bounds tab underneath leaks
      // through — the tab bar shows the new selection while the viewport
      // shows a different tab's content. Mirrors selectTabHandler.
      this.promoteSelectedToFront();
    }
    this.pushStateToRenderer();
  }

  async selectTabHandler(request: { tabId: string }): Promise<void> {
    if (!this.presenter.selectTab(request.tabId)) return;
    // Promote the new selection to the top of the z-order immediately. The
    // renderer's MutationObserver-driven bounds sync fires reliably when
    // the user clicks a tab but can miss programmatic (CDP) selection —
    // doing it here means selectTab's visual effect is deterministic.
    this.promoteSelectedToFront();
    this.pushStateToRenderer();
  }

  // Promote the currently-selected tab to the top of the z-order with full
  // bounds. Keeps the main-process view geometry in sync with the logical
  // selection — without this, a tab switch that doesn't reach the renderer
  // (e.g. keyboard shortcut) leaves the previously-selected tab still
  // painting on top until the renderer's ResizeObserver catches up.
  private promoteSelectedToFront(): void {
    this.layout.promoteSelectedToFront();
  }

  async reloadTabHandler(request: { tabId: string }): Promise<void> {
    const tab = this.tabById(request.tabId);
    if (!tab) {
      throw new Error(`Page not found: ${request.tabId}`);
    }
    const viewUpdatedAt = tab.type === 'view' && tab.target
      ? await this.resolveViewUpdatedAt(tab.target)
      : undefined;
    if (!this.presenter.markTabFresh(request.tabId, { viewUpdatedAt })) {
      throw new Error(`Page not found: ${request.tabId}`);
    }
    this.reloadTabView(request.tabId);
    this.pushStateToRenderer();
    // Wait for the page to finish loading so callers know when the reload is complete.
    await this.resolveReadyTabViewState(request.tabId);
  }

  async captureTabById(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }> {
    const state = await this.resolveReadyTabViewState(request.tabId);
    const wc = state.view.webContents;
    const originalBounds = state.view.getBounds();
    // capturePage needs a real compositor surface, which a view parked at 0x0
    // does not have. Non-selected client pages sit at 0x0 whenever the
    // renderer reports them not-visible, so give them the selected tab's size
    // for the duration of the capture — but off-screen, at the same
    // far-negative origin headless pages use. Placing a capture target inside
    // the visible content area makes it flash over the UI (nothing occludes it
    // in zen mode, where every tab is collapsed to 0x0), and sized headless
    // pages already have a surface, so they are captured exactly where they
    // are, at the viewport the caller asked for.
    const isSelected = request.tabId === this.presenter.getSelectedTabId();
    const needsRebounds = !isSelected
      && (originalBounds.width === 0 || originalBounds.height === 0);
    if (needsRebounds) {
      const selectedBounds = this.layout.getSelectedBounds();
      const captureSize = selectedBounds && selectedBounds.width > 0 && selectedBounds.height > 0
        ? { width: selectedBounds.width, height: selectedBounds.height }
        : { width: FALLBACK_VIEW_WIDTH, height: FALLBACK_VIEW_HEIGHT };
      state.view.setBounds({
        x: CAPTURE_OFFSCREEN_OFFSET,
        y: CAPTURE_OFFSCREEN_OFFSET,
        width: captureSize.width,
        height: captureSize.height,
      });
      state.view.setVisible(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    try {
      // Only the on-screen tab has a compositor display surface, so capturePage
      // is the cheap path there and Page.captureScreenshot the backstop. Every
      // other page is off-screen: capturePage fails on it with "Current display
      // surface not available" until something forces a surface into existence,
      // and retrying that for the full budget just stalls the caller. CDP
      // renders off-screen content directly, so it leads for those.
      const attempts: Array<{ label: string; run: () => Promise<{ base64: string; mimeType: 'image/png' }> }> = isSelected
        ? [
          { label: 'capturePage', run: () => this.captureTabByCapturePage(wc) },
          { label: 'Page.captureScreenshot', run: () => this.captureTabByCdp(request.tabId) },
        ]
        : [
          { label: 'Page.captureScreenshot', run: () => this.captureTabByCdp(request.tabId) },
          { label: 'capturePage', run: () => this.captureTabByCapturePage(wc) },
        ];

      const failures: string[] = [];
      for (const attempt of attempts) {
        try {
          return await attempt.run();
        } catch (err) {
          failures.push(`${attempt.label} failed (${errorMessage(err)})`);
        }
      }
      throw new Error(failures.join('; '));
    } finally {
      if (needsRebounds && !wc.isDestroyed()) {
        state.view.setBounds(originalBounds);
      }
    }
  }

  private async captureTabByCapturePage(wc: WebContents): Promise<{ base64: string; mimeType: 'image/png' }> {
    // Transient Chromium errors from capturePage: "UnknownVizError" (Viz
    // frame sink not registered yet) and "Current display surface not
    // available" (RWHV null). Retry on a short budget.
    const deadline = Date.now() + 3000;
    let lastCaptureError: unknown = null;
    while (true) {
      try {
        const image = await withTimeout(
          wc.capturePage(undefined, { stayHidden: true }),
          CAPTURE_PAGE_ATTEMPT_TIMEOUT_MS,
          'capturePage',
        );
        const png = image.toPNG();
        if (png.byteLength === 0) {
          throw new Error('capturePage returned an empty image');
        }
        return {
          base64: png.toString('base64'),
          mimeType: 'image/png',
        };
      } catch (err) {
        lastCaptureError = err;
        const msg = String(err);
        const retriable = msg.includes('UnknownVizError')
          || msg.includes('display surface')
          || msg.includes('empty image')
          || msg.includes('timed out');
        if (!retriable || Date.now() >= deadline || wc.isDestroyed()) {
          throw lastCaptureError;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private async captureTabByCdp(tabId: string): Promise<{ base64: string; mimeType: 'image/png' }> {
    const result = await withTimeout(
      this.pageDebugger.send({
        tabId,
        method: 'Page.captureScreenshot',
        params: {
          format: 'png',
          captureBeyondViewport: false,
        },
      }) as Promise<{ data?: unknown }>,
      CAPTURE_CDP_TIMEOUT_MS,
      'Page.captureScreenshot',
    );

    if (typeof result.data !== 'string' || result.data.length === 0) {
      throw new Error('Page.captureScreenshot did not return image data');
    }

    return {
      base64: result.data,
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
    const state = await this.resolveReadyTabViewState(request.tabId);
    if (typeof request.code !== 'string') {
      throw new Error('runPageJs requires code as a string');
    }

    // Syntax-probe in the main process, then send a fully expanded async
    // function to the tab. Creating Function/AsyncFunction inside the page is
    // blocked by strict CSPs such as TradingView's script-src without unsafe-eval.
    const { timeoutMs, wasDefault } = resolvePageJsTimeout(request.timeoutMs);
    const wrappedCode = buildPageExecutionCode(request.code);
    return withPageJsTimeout(state.view.webContents.executeJavaScript(wrappedCode, true), timeoutMs, wasDefault);
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
    const input = normalizePageInput(request);

    if (input.type === 'click') {
      wc.sendInputEvent({
        type: 'mouseDown',
        x: input.x,
        y: input.y,
        button: input.button ?? 'left',
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      });
      wc.sendInputEvent({
        type: 'mouseUp',
        x: input.x,
        y: input.y,
        button: input.button ?? 'left',
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      });
      return;
    }

    if (input.type === 'mouseWheel') {
      wc.sendInputEvent({
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      });
      return;
    }

    if (PAGE_MOUSE_EVENT_TYPES.has(input.type)) {
      wc.sendInputEvent({
        type: input.type as 'mouseDown' | 'mouseUp' | 'mouseMove',
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.type === 'mouseDown' ? input.clickCount : undefined,
        modifiers: input.modifiers,
      });
      return;
    }

    if (PAGE_KEY_EVENT_TYPES.has(input.type)) {
      wc.sendInputEvent({
        type: input.type as 'keyDown' | 'keyUp' | 'char',
        keyCode: input.keyCode!,
        modifiers: input.modifiers,
      });
      return;
    }
  }

  async inspectElementById(request: {
    tabId: string
    selector: string
  }): Promise<unknown> {
    return this.execTabJsById({
      tabId: request.tabId,
      code: buildInspectElementCode(request.selector),
    });
  }

  // --- Tab state mutations ---

  markViewChanged(viewName: string): void {
    if (this.presenter.markViewChanged(viewName)) {
      this.pushStateToRenderer();
    }
  }

  togglePin(tabId: string): void {
    this.presenter.togglePin(tabId);
  }

  reorderTabs(fromIndex: number, toIndex: number): void {
    this.presenter.reorderTabs(fromIndex, toIndex);
  }

  closeCurrentTab(): void {
    const selectedTabId = this.presenter.getSelectedTabId();
    if (!selectedTabId) return;
    this.closeTabHandler({ tabId: selectedTabId });
  }

  reloadCurrentTab(): void {
    const selectedTabId = this.presenter.getSelectedTabId();
    if (!selectedTabId) return;
    this.reloadTabHandler({ tabId: selectedTabId });
  }

  /** Switch to the Nth visible tab (0-based index). */
  switchToTabByIndex(index: number): void {
    if (!this.presenter.selectVisibleTabByIndex(index)) return;
    this.promoteSelectedToFront();
    this.pushStateToRenderer();
  }

  /** Switch to the next visible tab, wrapping around. */
  nextTab(): void {
    if (!this.presenter.selectNextVisibleTab()) return;
    this.promoteSelectedToFront();
    this.pushStateToRenderer();
  }

  /** Switch to the previous visible tab, wrapping around. */
  previousTab(): void {
    if (!this.presenter.selectPreviousVisibleTab()) return;
    this.promoteSelectedToFront();
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
    const tab = tabId ? this.tabById(tabId) : undefined;
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
