// Constructs a RemoteBackend pointed at the daemon and attaches the mobile
// remote-mirror so the local SQLite mirror stays in sync with daemon state.
//
// Status/events subscribers are wired BEFORE backend.start() so no events
// emitted during startup can be lost. Endpoint registration with the Rust
// URI handler is NOT done here — the controller owns that lifecycle so a
// superseded connect can't clobber the live session's endpoint via stop().

import type {
  AgentBackendEvent,
  BackendStatusSnapshot,
  Unsubscribe,
} from '#shared/backend/interface.js'
import { RemoteBackend } from '#shared/backend/remote.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import type { PageApi } from '#shared/page/types.js'
import { MobileRemoteMirror } from './remote-mirror.js'

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
  onStatus?: (status: BackendStatusSnapshot) => void
  onEvent?: (event: AgentBackendEvent) => void
  clientPages?: PageApi
}

export async function createMobileBackend(opts: MobileBackendOptions): Promise<MobileBackend> {
  const backend = new RemoteBackend({
    id: opts.agentId,
    baseUrl: opts.baseUrl,
    agentToken: opts.agentToken,
    clientPages: opts.clientPages,
  })

  const subscriberUnsubs: Unsubscribe[] = []
  if (opts.onStatus) subscriberUnsubs.push(backend.status.subscribe(opts.onStatus))
  if (opts.onEvent) subscriberUnsubs.push(backend.events.subscribe(opts.onEvent))

  const mirror = new MobileRemoteMirror({
    agentId: opts.agentId,
    remoteBackend: backend,
    onLocalDbChange: opts.onLocalDbChange,
    onSnapshotApplied: opts.onSnapshotApplied,
  })

  backend.attachDbSync(mirror)
  try {
    await backend.start()
  } catch (err) {
    // backend.start() may leave the WsClient mid-reconnect; tear it down
    // before propagating so we don't leak timers / sockets for a connect
    // that never committed.
    for (const unsub of subscriberUnsubs) unsub()
    await backend.stop().catch(() => {})
    throw err
  }

  return {
    backend,
    mirror,
    async stop() {
      for (const unsub of subscriberUnsubs) unsub()
      await backend.stop()
    },
  }
}
