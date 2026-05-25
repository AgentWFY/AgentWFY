// Constructs a RemoteBackend pointed at the daemon and attaches the mobile
// remote-mirror so the local SQLite mirror stays in sync with daemon state.

import { RemoteBackend } from '#shared/backend/remote.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { MobileRemoteMirror } from './remote-mirror.js'
import { bridge } from './tauri-bridge.js'

export interface MobileBackend {
  backend: RemoteBackend
  mirror: MobileRemoteMirror
  stop(): Promise<void>
}

export interface MobileBackendOptions {
  agentId: string
  baseUrl: string
  agentToken: string
  onLocalDbChange?: (change: AgentDbChange) => void
  onSnapshotApplied?: () => void
}

export async function createMobileBackend(opts: MobileBackendOptions): Promise<MobileBackend> {
  const backend = new RemoteBackend({
    id: opts.agentId,
    baseUrl: opts.baseUrl,
    agentToken: opts.agentToken,
  })

  const mirror = new MobileRemoteMirror({
    agentId: opts.agentId,
    remoteBackend: backend,
    onLocalDbChange: opts.onLocalDbChange,
    onSnapshotApplied: opts.onSnapshotApplied,
  })

  backend.attachDbSync(mirror)
  await backend.start()

  // The Rust URI handler needs the daemon endpoint to mint signed asset URLs
  // when the WebView issues `<img src="/screenshots/foo.png">` against the
  // agentview:// origin. Pushed here (not from Rust) so the same flow works
  // for any future TS-driven connection mode.
  await bridge.activeAgent.setEndpoint(opts.agentId, opts.baseUrl, opts.agentToken).catch((err) => {
    console.warn('[mobile-backend] set_active_agent_endpoint failed:', err)
  })

  return {
    backend,
    mirror,
    async stop() {
      await bridge.activeAgent.clearEndpoint().catch(() => {})
      await backend.stop()
    },
  }
}
