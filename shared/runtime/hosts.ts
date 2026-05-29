// Small host interfaces used by per-agent runtime code to avoid direct
// Electron coupling. The Electron app supplies real implementations; the
// server supplies no-op / undefined where features are absent.
//
// This file is part of the portable runtime surface — must remain free of
// Electron and DOM imports.

export interface NotificationHost {
  /** Show a system notification when a long-running agent completes. */
  show(opts: { title: string; body: string }): void
  /** Bounce the dock icon (macOS); no-op elsewhere. */
  bounce?(): void
}

export interface RendererPush {
  /**
   * Surface a "open this session in the chat panel" signal to the renderer.
   * Used by the openSessionInChat runtime function. The actual data work is
   * performed by AgentSessionManager — this is just the UI nudge.
   */
  openSessionInChat(detail: { sessionId: string; label: string }): void
}

export interface ExternalLauncher {
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>
}

// ── Tab hosts ────────────────────────────────────────────────────────────
// Surfaces the tab/browser-page operations used by runtime/functions/tabs.ts.
// VisibleTabHost owns user-facing tabs; BrowserHost owns headless rendered
// pages. TabRouter combines them into the single agent-facing TabApi.

export type ViewportAlias = 'mobile' | 'tablet' | 'desktop'

export interface ViewportSpec {
  width?: number
  height?: number
}

export interface Viewport {
  width: number
  height: number
}

export type ViewportInput = ViewportAlias | ViewportSpec

export type TabDataType = 'view' | 'file' | 'url'

export interface TabData {
  id: string
  tabId: string
  type: TabDataType
  title: string
  target: string | null
  headless: boolean
  viewport: Viewport | null
  viewUpdatedAt: number | null
  viewChanged: boolean
  pinned: boolean
  selected: boolean
  params: Record<string, string> | null
}

const VIEWPORT_ALIASES: Record<ViewportAlias, Viewport> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
}

export function resolveViewport(input?: ViewportInput): Viewport {
  if (typeof input === 'string') {
    return VIEWPORT_ALIASES[input] ?? VIEWPORT_ALIASES.desktop
  }

  const width = normalizeViewportDimension(input?.width, VIEWPORT_ALIASES.desktop.width)
  const height = normalizeViewportDimension(input?.height, VIEWPORT_ALIASES.desktop.height)
  return { width, height }
}

function normalizeViewportDimension(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(parsed))
}

export interface TabOpenRequest {
  viewName?: string
  view?: string
  filePath?: string
  url?: string
  title?: string
  headless?: boolean
  viewport?: ViewportInput
  params?: Record<string, string>
}

export interface BrowserOpenRequest extends Omit<TabOpenRequest, 'headless'> {
  headless: true
  viewport: Viewport
}

export interface TabCaptureResult {
  base64: string
  mimeType: 'image/png'
}

export interface TabConsoleLog {
  level: string
  message: string
  timestamp: number
}

export interface TabDebuggerBufferedEvent {
  method: string
  params: unknown
  sessionId?: string
}

export interface TabDebuggerPollResult {
  events: TabDebuggerBufferedEvent[]
  dropped: number
  closed: boolean
}

export interface BrowserCdpSubscription {
  poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<TabDebuggerPollResult>
  close(): Promise<void>
}

export interface BrowserScreencastFrame {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  metadata?: unknown
}

export interface BrowserPageHandle {
  tabId: string
  viewport: Viewport
  sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  subscribeCdp(events: string[]): BrowserCdpSubscription
  startScreencast?(opts: { format?: 'png' | 'jpeg'; quality?: number; maxFps?: number }): AsyncIterable<BrowserScreencastFrame>
  getConsoleLogs?(request?: { since?: number; limit?: number }): Promise<TabConsoleLog[]>
}

export interface BrowserHost {
  openPage(request: BrowserOpenRequest): Promise<BrowserPageHandle>
  closePage(tabId: string): Promise<void>
  getPage(tabId: string): BrowserPageHandle | null
  getTabs?(): Promise<TabData[]>
}

export interface TabSendInputRequest {
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
}

// Adapter for visible-tab operations (the user-facing tab bar). Desktop
// supplies one via buildVisibleTabTools; daemon has none and routes visible
// ops through a ClientInvoker instead.
export interface VisibleTabHost {
  getTabs: () => Promise<TabData[]>
  getCurrentTab: () => Promise<TabData | null>
  openTab: (request: TabOpenRequest) => Promise<{ tabId: string }>
  closeTab: (request: { tabId: string }) => Promise<void>
  selectTab: (request: { tabId: string }) => Promise<void>
  reloadTab: (request: { tabId: string }) => Promise<void>
  captureTab: (request: { tabId: string }) => Promise<TabCaptureResult>
  getTabConsoleLogs: (request: { tabId: string; since?: number; limit?: number }) => Promise<TabConsoleLog[]>
  execTabJs: (request: { tabId: string; code: string; timeoutMs?: number }) => Promise<unknown>
  sendInput: (request: TabSendInputRequest) => Promise<void>
  inspectElement: (request: { tabId: string; selector: string }) => Promise<unknown>
  tabDebuggerSend: (request: { tabId: string; method: string; params?: unknown; sessionId?: string }) => Promise<unknown>
  tabDebuggerSubscribe: (request: { tabId: string; subscriptionId: string; events: string[] }) => Promise<void>
  tabDebuggerPoll: (request: { subscriptionId: string; maxBatch?: number; maxWaitMs?: number }) => Promise<TabDebuggerPollResult>
  tabDebuggerUnsubscribe: (request: { subscriptionId: string }) => Promise<void>
  tabDebuggerDetach: (request: { tabId: string }) => Promise<void>
}

// Agent-facing unified tab surface. Same method set as VisibleTabHost but
// each call is dispatched per-tab to the right backend (VisibleTabHost /
// BrowserHost / ClientInvoker). Implemented by TabRouter.
export interface TabApi extends VisibleTabHost {}

// ── Palette host ─────────────────────────────────────────────────────────
// Surfaces the command-palette operations the runtime exposes as functions.
// Desktop supplies a CommandPaletteManager that structurally matches; daemon
// leaves it undefined so palette functions aren't registered.

export interface PaletteHost {
  requestPluginInstall: (packagePath: string) => Promise<{ installed: string[] }>
  requestPluginToggle: (pluginName: string) => Promise<{ toggled: boolean; enabled?: boolean }>
  requestPluginUninstall: (pluginName: string) => Promise<{ uninstalled: boolean }>
  confirmPluginInstall?: (
    packagePath: string,
    plugins: Array<Record<string, unknown>>,
  ) => Promise<boolean>
  confirmPluginToggle?: (plugin: Record<string, unknown> & { currentEnabled: boolean }) => Promise<boolean>
  confirmPluginUninstall?: (plugin: Record<string, unknown>) => Promise<boolean>
  pickFromPalette: (options: {
    items: Array<{ title: string; subtitle?: string; value: unknown }>
    title?: string
    placeholder?: string
    timeoutMs?: number
  }) => Promise<unknown | null>
}
