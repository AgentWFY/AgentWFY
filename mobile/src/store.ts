// Async subset of desktop/ipc/store.ts. Same get/set semantics, just awaitable
// because the Rust side is over IPC. Wrappers like `agent-meta.ts` import
// these directly so call sites match desktop's syntax.

import { bridge } from './tauri-bridge.js'

export function storeGet(key: string): Promise<unknown> {
  return bridge.store.get(key)
}

export function storeSet(key: string, value: unknown): Promise<void> {
  return bridge.store.set(key, value)
}
