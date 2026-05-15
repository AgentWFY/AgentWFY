// Per-agent metadata kept alongside installedAgents. Used to mark whether an
// agent is local (default) or backed by a remote daemon, and where to reach
// it. Stored as a single object in the Electron internal store, keyed by
// agent root path.
//
// Schema: { [agentId: string]: AgentMeta }
//   AgentMeta = { backend: 'local' | 'remote', remoteConfig?: RemoteConfig }
//
// Old installs (no entry) default to local — the existing behavior.

import { storeGet, storeSet } from './ipc/store.js'

const STORE_KEY = 'installedAgentMeta'

export interface RemoteAgentConfig {
  baseUrl: string
  agentToken: string
}

export interface AgentMeta {
  backend: 'local' | 'remote'
  remoteConfig?: RemoteAgentConfig
}

function readMap(): Record<string, AgentMeta> {
  const raw = storeGet(STORE_KEY)
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, AgentMeta> = {}
  for (const [path, meta] of Object.entries(raw as Record<string, unknown>)) {
    if (!meta || typeof meta !== 'object') continue
    const m = meta as Record<string, unknown>
    if (m.backend !== 'local' && m.backend !== 'remote') continue
    if (m.backend === 'remote') {
      const rc = m.remoteConfig as Record<string, unknown> | undefined
      if (!rc || typeof rc.baseUrl !== 'string' || typeof rc.agentToken !== 'string') continue
      out[path] = {
        backend: 'remote',
        remoteConfig: { baseUrl: rc.baseUrl, agentToken: rc.agentToken },
      }
    } else {
      out[path] = { backend: 'local' }
    }
  }
  return out
}

function writeMap(map: Record<string, AgentMeta>): void {
  storeSet(STORE_KEY, map)
}

export function getAgentMeta(agentId: string): AgentMeta {
  return readMap()[agentId] ?? { backend: 'local' }
}

export function setAgentMeta(agentId: string, meta: AgentMeta): void {
  const map = readMap()
  map[agentId] = meta
  writeMap(map)
}

export function removeAgentMeta(agentId: string): void {
  const map = readMap()
  if (!(agentId in map)) return
  delete map[agentId]
  writeMap(map)
}

export function listAgentMeta(): Record<string, AgentMeta> {
  return readMap()
}
