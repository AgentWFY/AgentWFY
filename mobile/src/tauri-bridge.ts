// Hand-rolled equivalent of the Electron preload's contextBridge surface.
//
// Tauri auto-injects `window.__TAURI_INTERNALS__.invoke(cmd, args)` into the
// webview — no preload file needed. This module wraps that primitive into the
// domain-typed object the rest of the renderer talks to (`bridge.mirrorDb.*`,
// `bridge.store.*`, …) so call sites never deal in stringly-typed command
// names. Rust-side `#[tauri::command]` handlers grow alongside the
// corresponding namespace here.

import type { AgentDbChange } from '#shared/db/sqlite.js'

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

/** Result of `mirrorDb.open`. `not_initialized` means the on-disk mirror is
 *  missing — the caller should fetch a snapshot from the daemon and call
 *  `replaceSnapshot` before issuing queries. */
export type MirrorDbOpenStatus = 'ready' | 'not_initialized'

export interface MirrorDbOpenResult {
  status: MirrorDbOpenStatus
}

export const bridge = {
  /** Local SQLite mirror of the daemon's agent DB. See
   *  mobile/src-tauri/src/mirror_db.rs for the Rust side. */
  mirrorDb: {
    open(agentId: string): Promise<MirrorDbOpenResult> {
      return invoke<MirrorDbOpenResult>('mirror_db_open', { agentId })
    },
    query(
      agentId: string,
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<Array<Record<string, unknown>>> {
      return invoke<Array<Record<string, unknown>>>('mirror_db_query', {
        agentId,
        sql,
        params: params ? Array.from(params) : [],
      })
    },
    applyChange(agentId: string, change: AgentDbChange): Promise<void> {
      return invoke<void>('mirror_db_apply_change', { agentId, change })
    },
    replaceSnapshot(agentId: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      // Tauri's default IPC serializes Uint8Array as a JSON array of bytes —
      // fine for snapshot sizes we expect (a few MB at most). If this turns
      // into a hotspot, switch to the raw-request IPC body.
      return invoke<void>('mirror_db_replace_snapshot', {
        agentId,
        bytes: Array.from(u8),
      })
    },
  },

  /** Daemon endpoint info shared with the Rust URI scheme handler so it can
   *  mint signed file URLs for browser-driven asset fetches. */
  activeAgent: {
    setEndpoint(agentId: string, baseUrl: string, token: string): Promise<void> {
      return invoke<void>('set_active_agent_endpoint', { agentId, baseUrl, token })
    },
    clearEndpoint(): Promise<void> {
      return invoke<void>('clear_active_agent_endpoint')
    },
  },

  /** Generic JSON key/value store backed by `<appData>/config.json`. Mobile
   *  exposes the get/set subset currently used by helpers like
   *  `agent-meta.ts`. */
  store: {
    get(key: string): Promise<unknown> {
      return invoke<unknown>('store_get', { key })
    },
    set(key: string, value: unknown): Promise<void> {
      return invoke<void>('store_set', { key, value })
    },
  },
}
