// Constructs a RemoteBackend pointed at the daemon and attaches the mobile
// remote-mirror so the local SQLite mirror stays in sync with daemon state.

import { RemoteBackend } from '#shared/backend/remote.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
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

  return {
    backend,
    mirror,
    async stop() {
      await backend.stop()
    },
  }
}
