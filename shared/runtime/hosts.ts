// Small host interfaces used by per-agent runtime code to avoid direct
// Electron coupling. The Electron app supplies real implementations; the
// remote-backend-server supplies no-op / undefined where features are absent.
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
  openSessionInChat(detail: { file: string; label: string }): void
}

export interface ExternalLauncher {
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>
}

// ── Tab host ─────────────────────────────────────────────────────────────
// Surfaces the tab/browser-view operations used by runtime/functions/tabs.ts.
// The Electron app supplies this via TabViewManager; daemon deployments leave
// it undefined so tab functions aren't registered.

export interface TabOpenRequest {
  viewName?: string
  view?: string
  filePath?: string
  url?: string
  title?: string
  hidden?: boolean
  params?: Record<string, string>
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

export interface TabHost {
  getTabs: () => Promise<Array<Record<string, unknown>>>
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
