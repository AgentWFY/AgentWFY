// Hand-rolled equivalent of the Electron preload's contextBridge surface.
//
// Tauri auto-injects `window.__TAURI_INTERNALS__.invoke(cmd, args)` into the
// webview — no preload file needed. This module wraps that primitive into the
// domain-typed object the rest of the renderer talks to (`bridge.mirrorDb.*`,
// `bridge.backend.*`, …) so call sites never deal in stringly-typed command
// names. Rust-side `#[tauri::command]` handlers grow alongside the
// corresponding namespace here.

interface TauriInternals {
  invoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
    options?: unknown,
  ): Promise<T>
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals
  }
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = window.__TAURI_INTERNALS__
  if (!tauri) {
    return Promise.reject(
      new Error(
        `Tauri runtime not available — invoke("${cmd}") called outside the Tauri webview`,
      ),
    )
  }
  return tauri.invoke<T>(cmd, args)
}

// Domain namespaces will be added as Rust commands land.
//   - mirrorDb: opens / queries / applies-change to the local SQLite mirror (Step 5)
//   - backend: WS lifecycle if any of it ends up on the Rust side (Step 6)
// For now the bridge only exposes the raw escape hatch.
export const bridge = {
  /** Escape hatch for not-yet-typed Rust commands. Prefer adding a typed
   *  namespace once the command stabilizes. */
  raw: invoke,
}

export type Bridge = typeof bridge
