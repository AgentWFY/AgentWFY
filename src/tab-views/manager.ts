import { BaseWindow, BrowserWindow, Menu, nativeTheme, View, WebContents, WebContentsView, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type Rectangle } from 'electron';
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
const ZERO_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
// Far-negative origin for capturePage's forced paint. Any realistic desktop
// window fits inside a 30k pixel half-plane around the origin, so painting
// at this coordinate is guaranteed off-screen.
const CAPTURE_OFFSCREEN_OFFSET = -30000;
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
  // Views that must stay above the selected tab in the window's child
  // stack (command palette, confirmation dialog, preview cursor).
  // Invoked once per bringToFront; should be cheap.
  getOverlayViews?: () => ReadonlyArray<WebContentsView>;
}

interface BufferedDebuggerEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}

interface DebuggerPollWaiter {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface DebuggerSubscription {
  subscriptionId: string;
  tabId: string;
  events: Set<string>;
  buffer: BufferedDebuggerEvent[];
  dropped: number;
  closed: boolean;
  waiter: DebuggerPollWaiter | null;
}

interface DebuggerAttachment {
  messageHandler: (event: Electron.Event, method: string, params: unknown, sessionId: string) => void;
  detachHandler: (event: Electron.Event, reason: string) => void;
}

const DEBUGGER_BUFFER_MAX = 1000;
const DEBUGGER_POLL_MAX_WAIT_MS = 60_000;

export class TabViewManager {
  private readonly tabViewsByTabId = new Map<string, TabViewState>();
  private readonly viewRuntimeEntries = new Map<number, ViewRuntimeEntry>();
  private readonly debuggerAttachments = new Map<string, DebuggerAttachment>();
  private readonly debuggerSubscriptions = new Map<string, DebuggerSubscription>();
  private readonly debuggerSubscriptionsByTab = new Map<string, Set<string>>();
  private readonly deps: TabViewManagerDeps;
  private tabs: TabData[] = [];
  private selectedTabId: string | null = null;
  private selectedBounds: Rectangle | null = null;
  // True while setAllTabsCollapsed has forced every view to 0x0 (zen mode,
  // app hidden). Placement paths (bringToFront, applyTabViewPlacement)
  // must be no-ops while this is set, or a keyboard shortcut or agent
  // switch would re-expand the selected tab on top of the zen-mode UI
  // with no way for the renderer to undo it (the ancestor display:none
  // suppresses ResizeObserver).
  private collapsed = false;
  // True only for the agent currently shown in the window. All WebContentsViews
  // — active and inactive — share mainWindow.contentView.children, so an
  // inactive manager must keep its views at 0x0 bounds (setVisible stays true
  // for captureTab). Otherwise a just-closed active tab unmasks an inactive
  // agent's view underneath, or a background openTab pops on top of the
  // active agent.
  private isActive = false;

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
    const mainWindow = this.deps.getMainWindow();
    const children = mainWindow && !mainWindow.isDestroyed() ? mainWindow.contentView.children : [];
    const tabs = Array.from(this.tabViewsByTabId.values()).map((state) => ({
      tabId: state.tabId,
      viewName: state.viewName,
      bounds: state.view.getBounds(),
      zIndex: children.indexOf(state.view),
      visible: state.view.getVisible(),
      isSelected: state.tabId === this.selectedTabId,
    }));
    return {
      selectedTabId: this.selectedTabId,
      selectedBounds: this.selectedBounds,
      totalChildren: children.length,
      tabs,
    };
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

    if (mainWindow.contentView.children.includes(state.view)) {
      return;
    }

    try {
      mainWindow.contentView.addChildView(state.view);
    } catch {
      // defensive: Electron may still consider it a child
    }
  }

  private bringToFront(state: TabViewState): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    // While collapsed, only setAllTabsCollapsed(false) may restore bounds —
    // agent switches and tab-nav shortcuts must not un-collapse zen mode.
    // Inactive agents likewise stay at 0x0 until activateViews runs.
    if (this.collapsed || !this.isActive) {
      return;
    }

    // Always restore full bounds + visibility — the promoted tab may have
    // been a background tab collapsed to 0x0, and we must reverse that
    // before the compositor paints the next frame.
    state.view.setBounds(this.selectedBounds ?? this.defaultContentBounds());
    state.view.setVisible(true);

    const children = mainWindow.contentView.children;
    const currentIndex = children.indexOf(state.view);
    if (currentIndex < 0) return;

    const overlayViews = this.deps.getOverlayViews?.() ?? [];
    const overlaySet = new Set<View>(overlayViews);

    // Skip the reorder when the tab already sits at the top of the
    // non-overlays — addChildView on an attached child tears down and
    // rebuilds its RenderWidgetHostView, briefly blanking the renderer
    // surface. This early-return keeps ResizeObserver-driven bounds
    // updates (header height transitions, sidebar toggles, …) from
    // ping-ponging the tab every animation frame.
    const aboveTab = children.slice(currentIndex + 1);
    if (aboveTab.every(c => overlaySet.has(c))) return;

    // addChildView on an attached child appends a duplicate. Explicit
    // remove + re-add is the only API that actually moves a child to
    // the top. Re-add the tab first, then each overlay in its current
    // relative order so overlays end up above the tab.
    const overlaysOrdered = children.filter(c => overlaySet.has(c));
    try {
      mainWindow.contentView.removeChildView(state.view);
      mainWindow.contentView.addChildView(state.view);
      for (const overlay of overlaysOrdered) {
        mainWindow.contentView.removeChildView(overlay);
        mainWindow.contentView.addChildView(overlay);
      }
    } catch {
      // defensive: a view may have been detached concurrently
    }
  }

  // All tab views stay setVisible(true) — across tabs and across agents.
  // captureTab needs a live compositor surface (capturePage fails with
  // "Current display surface not available" on setVisible(false) views).
  // Stacking is pure z-order: the selected tab sits on top and its opaque
  // WebContentsView background occludes the tabs behind it.
  private applyTabViewPlacement(state: TabViewState, bounds: Rectangle, visible: boolean): void {
    this.attachTabViewToWindow(state);

    // Inactive agents keep every view at 0x0 regardless of what the renderer
    // or openTab requested, while staying setVisible(true) from creation so
    // captureTab's capturePage retains a live compositor surface for
    // background sessions.
    if (!this.isActive) {
      state.view.setBounds(ZERO_BOUNDS);
      return;
    }

    if (visible) {
      // While collapsed, only setAllTabsCollapsed(false) may restore bounds.
      // bringToFront already bails for the same reason; the early-return
      // here additionally prevents the propagation loop below from
      // re-expanding background tabs.
      if (this.collapsed) {
        return;
      }
      const changed =
        !this.selectedBounds ||
        this.selectedBounds.x !== bounds.x ||
        this.selectedBounds.y !== bounds.y ||
        this.selectedBounds.width !== bounds.width ||
        this.selectedBounds.height !== bounds.height;
      if (changed) {
        this.selectedBounds = bounds;
        // Propagate to every background tab so the selected tab on top
        // occludes them exactly — otherwise sidebar/header would leak.
        for (const other of this.tabViewsByTabId.values()) {
          if (other !== state) other.view.setBounds(bounds);
        }
      }
      this.bringToFront(state);
    } else {
      // Honor the renderer's bounds for not-visible tabs. Display:none
      // panels report 0x0 — the view shrinks to nothing while staying
      // setVisible(true) so captureTab's capturePage still has a live
      // compositor surface.
      state.view.setBounds(bounds);
      state.view.setVisible(true);

      if (state.tabId === this.selectedTabId) {
        // The *selected* tab reporting not-visible means the whole tab
        // area is collapsed (zen mode, app hidden). The renderer only
        // fires bounds events for panels whose style changed; the other
        // panels were already display:none and stay that way, so we
        // won't get a per-tab event for them. Collapse every other tab
        // to 0x0 proactively so nothing leaks through.
        for (const other of this.tabViewsByTabId.values()) {
          if (other !== state) {
            other.view.setBounds(ZERO_BOUNDS);
          }
        }
      } else {
        // A freshly-attached background tab lands at the end of
        // children — topmost in z-order — and would occlude the
        // selected tab until the renderer reports 0x0 bounds for it.
        // Re-assert the selected tab's top-of-stack position.
        const selected = this.selectedTabId ? this.tabViewsByTabId.get(this.selectedTabId) : undefined;
        if (selected) {
          this.bringToFront(selected);
        }
      }
    }
  }

  private defaultContentBounds(): Rectangle {
    const mainWindow = this.deps.getMainWindow();
    const [w, h] = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getContentSize()
      : [FALLBACK_VIEW_WIDTH, FALLBACK_VIEW_HEIGHT];
    return { x: 0, y: 0, width: w, height: h };
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
    this.tabs = [];
    this.selectedTabId = null;
  }

  // --- Debugger (Chrome DevTools Protocol) ---

  private ensureDebuggerAttached(state: TabViewState): void {
    const tabId = state.tabId;
    if (this.debuggerAttachments.has(tabId)) {
      return;
    }

    const dbg = state.view.webContents.debugger;
    if (!dbg.isAttached()) {
      // Throws if another client (DevTools, another caller) is attached.
      // Surface the original error so the agent sees the real reason.
      dbg.attach('1.3');
    }

    const messageHandler = (
      _event: Electron.Event,
      method: string,
      params: unknown,
      sessionId: string,
    ) => {
      const subIds = this.debuggerSubscriptionsByTab.get(tabId);
      if (!subIds || subIds.size === 0) return;
      for (const subId of subIds) {
        const sub = this.debuggerSubscriptions.get(subId);
        if (!sub || sub.closed) continue;
        if (!sub.events.has('*') && !sub.events.has(method)) continue;
        this.pushDebuggerEvent(sub, { method, params, sessionId: sessionId || undefined });
      }
    };

    const detachHandler = (_event: Electron.Event, reason: string) => {
      // External detach (DevTools opened, target crashed) — clean up so the
      // next send/subscribe re-attaches and so pollers wake and exit.
      console.warn(`[TabViewManager] debugger detached from tab "${tabId}": ${reason}`);
      this.cleanupDebuggerForTab(tabId);
    };

    dbg.on('message', messageHandler);
    dbg.on('detach', detachHandler);

    this.debuggerAttachments.set(tabId, { messageHandler, detachHandler });
  }

  private pushDebuggerEvent(sub: DebuggerSubscription, evt: BufferedDebuggerEvent): void {
    if (sub.buffer.length >= DEBUGGER_BUFFER_MAX) {
      sub.buffer.shift();
      sub.dropped++;
    }
    sub.buffer.push(evt);
    this.wakeDebuggerPoller(sub);
  }

  private wakeDebuggerPoller(sub: DebuggerSubscription): void {
    const w = sub.waiter;
    if (!w) return;
    sub.waiter = null;
    if (w.timer) clearTimeout(w.timer);
    w.resolve();
  }

  private closeDebuggerSubscription(sub: DebuggerSubscription): void {
    if (sub.closed) return;
    sub.closed = true;
    this.wakeDebuggerPoller(sub);
  }

  private cleanupDebuggerForTab(tabId: string): void {
    const subIds = this.debuggerSubscriptionsByTab.get(tabId);
    if (subIds) {
      for (const subId of subIds) {
        const sub = this.debuggerSubscriptions.get(subId);
        if (sub) this.closeDebuggerSubscription(sub);
      }
      // Subscriptions stay in the map so pending pollers can drain remaining
      // buffered events; freed by the final poll once they see closed=true.
      this.debuggerSubscriptionsByTab.delete(tabId);
    }

    const attachment = this.debuggerAttachments.get(tabId);
    if (!attachment) return;
    this.debuggerAttachments.delete(tabId);

    const state = this.tabViewsByTabId.get(tabId);
    if (!state) return;
    const wc = state.view.webContents;
    if (wc.isDestroyed()) return;

    const dbg = wc.debugger;
    dbg.removeListener('message', attachment.messageHandler);
    dbg.removeListener('detach', attachment.detachHandler);
    if (dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (err) {
        console.warn(`[TabViewManager] debugger.detach failed for tab "${tabId}"`, err);
      }
    }
  }

  async tabDebuggerSendById(request: {
    tabId: string;
    method: string;
    params?: unknown;
    sessionId?: string;
  }): Promise<unknown> {
    const state = await this.resolveReadyTabViewState(request.tabId);
    this.ensureDebuggerAttached(state);
    const dbg = state.view.webContents.debugger;
    // Electron typings declare params as object; CDP commands without params
    // accept undefined at runtime.
    const params = (request.params ?? {}) as Record<string, unknown>;
    if (request.sessionId) {
      return dbg.sendCommand(request.method, params, request.sessionId);
    }
    return dbg.sendCommand(request.method, params);
  }

  tabDebuggerSubscribeById(request: {
    tabId: string;
    subscriptionId: string;
    events: string[];
  }): void {
    const state = this.resolveTabViewState(request.tabId);
    this.ensureDebuggerAttached(state);

    const sub: DebuggerSubscription = {
      subscriptionId: request.subscriptionId,
      tabId: request.tabId,
      events: new Set(request.events),
      buffer: [],
      dropped: 0,
      closed: false,
      waiter: null,
    };
    this.debuggerSubscriptions.set(request.subscriptionId, sub);

    let subIds = this.debuggerSubscriptionsByTab.get(request.tabId);
    if (!subIds) {
      subIds = new Set();
      this.debuggerSubscriptionsByTab.set(request.tabId, subIds);
    }
    subIds.add(request.subscriptionId);
  }

  async tabDebuggerPollById(request: {
    subscriptionId: string;
    maxBatch?: number;
    maxWaitMs?: number;
  }): Promise<{ events: BufferedDebuggerEvent[]; dropped: number; closed: boolean }> {
    const sub = this.debuggerSubscriptions.get(request.subscriptionId);
    if (!sub) {
      throw new Error(`Unknown debugger subscription "${request.subscriptionId}"`);
    }
    const maxBatch = Math.max(1, Math.min(1000, request.maxBatch ?? 100));
    const maxWaitMs = Math.max(0, Math.min(DEBUGGER_POLL_MAX_WAIT_MS, request.maxWaitMs ?? 30_000));

    if (sub.buffer.length === 0 && !sub.closed && maxWaitMs > 0) {
      if (sub.waiter) {
        throw new Error(`Concurrent poll on debugger subscription "${request.subscriptionId}" is not supported`);
      }
      await new Promise<void>((resolve) => {
        const waiter: DebuggerPollWaiter = { resolve, timer: undefined };
        sub.waiter = waiter;
        waiter.timer = setTimeout(() => {
          if (sub.waiter === waiter) {
            sub.waiter = null;
            resolve();
          }
        }, maxWaitMs);
      });
    }

    const events = sub.buffer.splice(0, maxBatch);
    const dropped = sub.dropped;
    sub.dropped = 0;
    const closed = sub.closed && sub.buffer.length === 0;

    // Free fully-drained closed subscriptions so the id can't be polled again.
    if (closed) {
      this.debuggerSubscriptions.delete(request.subscriptionId);
    }

    return { events, dropped, closed };
  }

  tabDebuggerUnsubscribeById(subscriptionId: string): void {
    const sub = this.debuggerSubscriptions.get(subscriptionId);
    if (!sub) return;
    this.closeDebuggerSubscription(sub);
    // Drop from the per-tab index so a later attach doesn't revive it.
    const subIds = this.debuggerSubscriptionsByTab.get(sub.tabId);
    if (subIds) {
      subIds.delete(subscriptionId);
      if (subIds.size === 0) {
        this.debuggerSubscriptionsByTab.delete(sub.tabId);
      }
    }
    if (!sub.waiter) {
      this.debuggerSubscriptions.delete(subscriptionId);
    }
  }

  tabDebuggerDetachById(tabId: string): void {
    this.cleanupDebuggerForTab(tabId);
  }

  // Brings this agent's selected tab above other agents' views on a switch.
  activateViews(): void {
    this.isActive = true;
    const selected = this.selectedTabId ? this.tabViewsByTabId.get(this.selectedTabId) : undefined;
    if (selected) {
      this.bringToFront(selected);
    }
    this.pushStateToRenderer();
  }

  // Inverse of activateViews. Called on the outgoing agent during a switch
  // so its views can't leak through when the incoming agent has no selected
  // tab on top (e.g. user just closed the last tab). Views stay attached
  // and setVisible(true) so captureTab keeps working for background sessions.
  deactivateViews(): void {
    this.isActive = false;
    this.zeroAllViewBounds();
  }

  private zeroAllViewBounds(): void {
    for (const state of this.tabViewsByTabId.values()) {
      state.view.setBounds(ZERO_BOUNDS);
    }
  }

  // Directly shrink/restore every tab view in response to main-process
  // signals (zen mode, window hidden, etc.) that the renderer's
  // ResizeObserver/MutationObserver chain won't pick up — zen mode
  // removes the tab area from the box tree by an ancestor display:none,
  // which per spec doesn't fire ResizeObserver.
  setAllTabsCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    if (collapsed) {
      this.zeroAllViewBounds();
    } else if (this.isActive && this.selectedBounds) {
      // Only the active agent's views should re-expand on zen exit; inactive
      // agents must stay at 0x0 or they'd unmask underneath the active agent.
      // Hidden tabs must also stay at 0x0 — the renderer's bounds-sync path
      // skips them by design, so they'd otherwise remain full-size and show
      // through once the visible selection goes away.
      const hiddenTabIds = new Set(this.tabs.filter(t => t.hidden).map(t => t.id));
      for (const [tabId, state] of this.tabViewsByTabId) {
        if (hiddenTabIds.has(tabId)) {
          state.view.setBounds(ZERO_BOUNDS);
        } else {
          state.view.setBounds(this.selectedBounds);
        }
      }
      const selected = this.selectedTabId ? this.tabViewsByTabId.get(this.selectedTabId) : undefined;
      if (selected) this.bringToFront(selected);
    }
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
      // A scheme-less URL makes loadURL reject with ERR_INVALID_URL after the
      // tab is already attached and selected, leaving a zombie tab that
      // occludes the previous one and hangs execTabJs/devtools. Validate up
      // front so callers get a synchronous error instead.
      try {
        new URL(target);
      } catch {
        const looksLikePath = target.startsWith('/') || target.startsWith('./') || target.startsWith('file/');
        const hint = looksLikePath ? ' Did you mean to pass filePath instead of url?' : '';
        throw new Error(`openTab url must be an absolute URL with a scheme (got ${JSON.stringify(target)}).${hint}`);
      }
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
    this.applyTabViewPlacement(state, this.defaultContentBounds(), !isHidden);

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

    const wasSelected = this.selectedTabId === request.tabId;
    this.tabs = this.tabs.filter(t => t.id !== request.tabId);
    this.destroyTabView(request.tabId);

    if (wasSelected) {
      const visible = this.tabs.filter(t => !t.hidden);
      const last = visible[visible.length - 1];
      this.selectedTabId = last?.id || null;
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
    const tab = this.tabs.find(t => t.id === request.tabId);
    if (!tab) return;
    // Selecting a hidden tab must also reveal it — the renderer keeps hidden
    // tabs at display:none regardless of selectedTabId, so without this the
    // main-process selection silently desyncs from what the user sees.
    if (tab.hidden) {
      this.revealTab(request.tabId);
      return;
    }
    if (this.selectedTabId === request.tabId) return;
    this.selectedTabId = request.tabId;
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
    if (!this.selectedTabId) return;
    const state = this.tabViewsByTabId.get(this.selectedTabId);
    if (!state) return;
    this.applyTabViewPlacement(state, this.selectedBounds ?? this.defaultContentBounds(), true);
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
    // Only a zero-sized view (hidden tab or inactive agent) gets force-painted
    // at origin by the capture — move that one off-screen first.
    const needsRebounds = originalBounds.width === 0 || originalBounds.height === 0;
    const captureSize = this.selectedBounds && this.selectedBounds.width > 0 && this.selectedBounds.height > 0
      ? { width: this.selectedBounds.width, height: this.selectedBounds.height }
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
    this.promoteSelectedToFront();
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
    this.promoteSelectedToFront();
    this.pushStateToRenderer();
  }

  /** Switch to the next visible tab, wrapping around. */
  nextTab(): void {
    const visible = this.tabs.filter(t => !t.hidden);
    if (visible.length <= 1) return;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % visible.length;
    this.selectedTabId = visible[nextIdx].id;
    this.promoteSelectedToFront();
    this.pushStateToRenderer();
  }

  /** Switch to the previous visible tab, wrapping around. */
  previousTab(): void {
    const visible = this.tabs.filter(t => !t.hidden);
    if (visible.length <= 1) return;
    const currentIdx = visible.findIndex(t => t.id === this.selectedTabId);
    const prevIdx = currentIdx <= 0 ? visible.length - 1 : currentIdx - 1;
    this.selectedTabId = visible[prevIdx].id;
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
