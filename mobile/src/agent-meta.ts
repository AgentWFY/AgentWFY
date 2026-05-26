// Per-agent metadata kept alongside `installedAgents`. Port of
// desktop/agent-meta.ts — same shape, same store key — so the two hosts can
// share understanding of what a remote agent profile looks like.
//
// Mobile is remote-only (mobile/ has no in-process agent runtime), so this
// module skips the `backend: 'local'` variant the desktop side carries.
// Adding it later, if mobile ever caches a local copy, would mean reusing
// desktop's exact AgentMeta union here.

import { storeGet, storeSet } from './store.js'

const STORE_KEY = 'installedAgentMeta'

export interface RemoteAgentConfig {
  baseUrl: string
  agentToken: string
}

export interface AgentMeta {
  remoteConfig: RemoteAgentConfig
}

async function readMap(): Promise<Record<string, AgentMeta>> {
  const raw = await storeGet(STORE_KEY)
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, AgentMeta> = {}
  for (const [agentId, meta] of Object.entries(raw as Record<string, unknown>)) {
    if (!meta || typeof meta !== 'object') continue
    const m = meta as Record<string, unknown>
    const rc = m.remoteConfig as Record<string, unknown> | undefined
    if (!rc || typeof rc.baseUrl !== 'string' || typeof rc.agentToken !== 'string') continue
    out[agentId] = { remoteConfig: { baseUrl: rc.baseUrl, agentToken: rc.agentToken } }
  }
  return out
}

async function writeMap(map: Record<string, AgentMeta>): Promise<void> {
  await storeSet(STORE_KEY, map)
}

export async function getAgentMeta(agentId: string): Promise<AgentMeta | null> {
  const map = await readMap()
  return map[agentId] ?? null
}

export async function getAllAgentMeta(): Promise<Record<string, AgentMeta>> {
  return readMap()
}

export async function setAgentMeta(agentId: string, meta: AgentMeta): Promise<void> {
  const map = await readMap()
  map[agentId] = meta
  await writeMap(map)
}

export async function removeAgentMeta(agentId: string): Promise<void> {
  const map = await readMap()
  if (!(agentId in map)) return
  delete map[agentId]
  await writeMap(map)
}

// --- Installed-agent list (mirrors desktop's window-manager helpers) ---

const INSTALLED_AGENTS_KEY = 'installedAgents'

export async function getInstalledAgentIds(): Promise<string[]> {
  const raw = await storeGet(INSTALLED_AGENTS_KEY)
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

export async function setInstalledAgentIds(ids: string[]): Promise<void> {
  await storeSet(INSTALLED_AGENTS_KEY, ids)
}

export async function addInstalledAgent(agentId: string): Promise<void> {
  const ids = await getInstalledAgentIds()
  if (ids.includes(agentId)) return
  ids.push(agentId)
  await setInstalledAgentIds(ids)
}

export async function removeInstalledAgent(agentId: string): Promise<void> {
  const ids = await getInstalledAgentIds()
  const next = ids.filter((id) => id !== agentId)
  if (next.length === ids.length) return
  await setInstalledAgentIds(next)
  await removeAgentMeta(agentId)
}

/** Convenience: combined view used by the renderer to render the list. */
export interface InstalledAgent {
  agentId: string
  meta: AgentMeta
}

export async function listInstalledAgents(): Promise<InstalledAgent[]> {
  const [ids, meta] = await Promise.all([getInstalledAgentIds(), getAllAgentMeta()])
  const out: InstalledAgent[] = []
  for (const id of ids) {
    const m = meta[id]
    if (!m) continue
    out.push({ agentId: id, meta: m })
  }
  return out
}
