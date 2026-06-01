import { BaseWindow, BrowserWindow, Menu, nativeTheme, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { isViewDocumentUrl, parseAgentPath, isAgentViewHostname } from '#shared/protocol/view-document.js';
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
  ViewRuntimeEntry,
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
  agentId: string;
  session: Electron.Session;
  registerSender?: (webContentsId: number) => void;
  unregisterSender?: (webContentsId: number) => void;
  // Views that must stay above the selected tab in the window's child
  // stack (command palette, confirmation dialog, preview cursor).
  // Invoked once per bringToFront; should be cheap.
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
}

export class TabViewManager {
  private readonly tabViewsByTabId = new Map<string, TabViewState>();
  private readonly viewRuntimeEntries = new Map<number, ViewRuntimeEntry>();
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
      this.clearHeadlessIdleTimer(tabId);
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

  private buildTabSrc(type: TabDataType, target: string, tabId: string, params?: Record<string, string>): string {
    if (type === 'url') return target;

    const encodedTabId = encodeURIComponent(tabId);
    const rev = Date.now();
    const host = agentHostname(this.deps.agentId);
    let url: string;
    if (type === 'file') {
      url = `https://${host}/view/${encodeURIComponent(target)}?source=file&rev=${rev}&tabId=${encodedTabId}`;
    } else {
      url = `https://${host}/view/${encodeURIComponent(target)}?rev=${rev}&tabId=${encodedTabId}`;
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
  // and setVisible(true) so captureTab keeps working for background sessions.
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

  // --- Tab handlers ---

  async getTabsHandler(): Promise<TabData[]> {
    return this.presenter.listTabsForRuntime();
  }

  async getCurrentTabHandler(): Promise<TabData | null> {
    return this.presenter.currentTabForRuntime();
  }

  async openTabHandler(request: {
    tabId?: string;
    viewName?: string;
    filePath?: string;
    url?: string;
    title?: string;
    headless?: boolean;
    viewport?: PageViewportInput;
    width?: number;
    height?: number;
    closeAfterIdleMs?: PageCloseAfterIdleMs;
    params?: Record<string, string>;
    select?: boolean;
  }): Promise<{ tabId: string }> {
    const type: TabDataType = request.url ? 'url' : request.filePath ? 'file' : 'view';
    let target: string;
    if (type === 'url') {
      target = request.url!;
      // A scheme-less URL makes loadURL reject with ERR_INVALID_URL after the
      // tab is already attached and selected, leaving a zombie tab that
      // occludes the previous one and hangs execTabJs/devtools. Validate up
      // front so callers get a synchronous error instead.
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        const looksLikePath = target.startsWith('/') || target.startsWith('./') || target.startsWith('file/');
        const hint = looksLikePath ? ' Did you mean to pass filePath instead of url?' : '';
        throw new Error(`openTab url must be an absolute URL with a scheme (got ${JSON.stringify(target)}).${hint}`);
      }
      // An unknown scheme (`view://`, `agent://`, …) parses fine but loadURL
      // rejects with ERR_UNKNOWN_URL_SCHEME asynchronously — the catch on
      // loadURL below merely logs it, so the agent sees a blank tab with no
      // error. Reject up front with a hint pointing at the right field.
      const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:']);
      if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
        const hint = parsed.protocol === 'view:'
          ? ' Did you mean to pass viewName instead of url?'
          : '';
        throw new Error(`openTab url scheme "${parsed.protocol}" is not supported (got ${JSON.stringify(target)}). Use http(s): or file:.${hint}`);
      }
    } else if (type === 'file') {
      target = request.filePath!;
    } else {
      target = request.viewName!;
    }

    const tabId = request.tabId ?? this.generateTabId();
    const isHeadless = Boolean(request.headless);
    const shouldSelect = !isHeadless && request.select !== false;
    const viewport = isHeadless ? resolvePageViewport(normalizePageViewportInput(request)) : null;
    const now = Date.now();
    const closeAfterIdleMs = isHeadless ? resolvePageCloseAfterIdleMs(request.closeAfterIdleMs) : null;
    const expiresAt = typeof closeAfterIdleMs === 'number' ? now + closeAfterIdleMs : null;
    const tab: TabData = {
      id: tabId,
      tabId,
      type,
      title: request.title || (type === 'url' ? 'Web Page' : type === 'file' ? 'File View' : 'Agent View'),
      target,
      viewUpdatedAt: null,
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
        console.error('[tabs] openTab loadURL failed:', error);
      }
    });

    if (isHeadless && viewport) {
      this.applyHeadlessViewport(state, viewport);
      this.scheduleHeadlessIdleClose(tabId);
    }

    this.pushStateToRenderer();
    return { tabId };
  }

  async closeTabHandler(request: { tabId: string }): Promise<void> {
    const result = this.presenter.closeTab(request.tabId);
    if (!result.closed) return;

    this.clearHeadlessIdleTimer(request.tabId);
    this.destroyTabView(request.tabId);

    if (result.wasSelected) {
      // Promote the new selection to the top of z-order with full bounds.
      // Background tabs sit at 0x0 bounds after the renderer reports them
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
    if (!this.presenter.markTabFresh(request.tabId)) return;
    this.reloadTabView(request.tabId);
    this.pushStateToRenderer();
    // Wait for the page to finish loading so callers know when the reload is complete.
    await this.resolveReadyTabViewState(request.tabId);
  }

  async captureTabById(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }> {
    const state = await this.resolveReadyTabViewState(request.tabId);
    const wc = state.view.webContents;
    // capturePage forces Chromium to paint a frame. For a background view the
    // compositor paints it for one frame at the view's origin using its
    // internal viewport size — the tab flashes over whatever the user is
    // looking at. Detaching the view from contentView breaks capturePage
    // (RWHV gets torn down), and stayHidden:true alone doesn't suppress the
    // flash for WebContentsView-attached contents.
    //
    // Workaround: move the view fully off-screen for the duration. The paint
    // still happens, but at negative coordinates where nothing is composited
    // on-screen. We preserve the view's size so the page doesn't relayout.
    const originalBounds = state.view.getBounds();
    // An on-screen tab (the active agent's selected tab) is already being
    // composited at its normal bounds; capturePage won't add any flash.
    // Only a zero-sized view (inactive agent) gets force-painted
    // at origin by the capture — move that one off-screen first.
    const needsRebounds = originalBounds.width === 0 || originalBounds.height === 0;
    const selectedBounds = this.layout.getSelectedBounds();
    const captureSize = selectedBounds && selectedBounds.width > 0 && selectedBounds.height > 0
      ? { width: selectedBounds.width, height: selectedBounds.height }
      : { width: FALLBACK_VIEW_WIDTH, height: FALLBACK_VIEW_HEIGHT };
    if (needsRebounds) {
      state.view.setBounds({
        x: CAPTURE_OFFSCREEN_OFFSET,
        y: CAPTURE_OFFSCREEN_OFFSET,
        width: captureSize.width,
        height: captureSize.height,
      });
    }
    try {
      // Transient Chromium errors from capturePage: "UnknownVizError" (Viz
      // frame sink not registered yet) and "Current display surface not
      // available" (RWHV null). Retry on a short budget.
      const deadline = Date.now() + 3000;
      while (true) {
        try {
          const image = await wc.capturePage(undefined, { stayHidden: true });
          return {
            base64: image.toPNG().toString('base64'),
            mimeType: 'image/png',
          };
        } catch (err) {
          const msg = String(err);
          const retriable = msg.includes('UnknownVizError') || msg.includes('display surface');
          if (!retriable || Date.now() >= deadline || wc.isDestroyed()) {
            throw err;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }
    } finally {
      if (needsRebounds && !wc.isDestroyed()) {
        state.view.setBounds(originalBounds);
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
    if (typeof urlString !== 'string' || !urlString.startsWith('https://')) {
      return null;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      return null;
    }

    if (!isAgentViewHostname(parsedUrl.hostname)) {
      return null;
    }
    if (!isViewDocumentUrl(parsedUrl)) {
      return null;
    }

    const info = parseAgentPath(parsedUrl.pathname);
    if (!info || info.kind !== 'view') {
      return null;
    }

    const rawTabId = parsedUrl.searchParams.get('tabId');
    const tabId = typeof rawTabId === 'string' && rawTabId.trim().length > 0 ? rawTabId.trim() : null;
    return { viewName: info.target, tabId };
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
