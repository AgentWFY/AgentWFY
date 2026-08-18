// Small host interfaces used by per-agent runtime code to avoid direct
// Electron coupling. The Electron app supplies real implementations; the
// server supplies no-op / undefined where features are absent.
//
// This file is part of the portable runtime surface — must remain free of
// Electron and DOM imports.

export interface NotificationHost {
  /**
   * Show a system notification. Fire-and-forget: platforms report delivery
   * failures asynchronously (macOS rejects via the `failed` event), so there
   * is nothing meaningful to return or await.
   */
  show(opts: {
    title: string
    body: string
    /** Suppress the notification sound. */
    silent?: boolean
    /** Invoked when the user clicks the notification banner. */
    onClick?: () => void
  }): void
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
