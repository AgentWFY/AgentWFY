// Persisted installed-agents list. Reads/writes the JSON store via
// agent-meta.ts and broadcasts agents-changed whenever the list mutates so
// any component (sidebar, add-agent screen, router) can react without
// re-fetching on its own clock.
//
// This service holds an in-memory cache of the list so synchronous reads
// (getAgents/getMeta) are possible from places like the sidebar render
// path; the cache is refreshed before every event.

import {
  addInstalledAgent,
  listInstalledAgents,
  removeInstalledAgent,
  setAgentMeta,
  type AgentMeta,
  type InstalledAgent,
} from '../agent-meta.js'
import { dispatch } from '../events.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'

class AgentRegistry {
  private agents: InstalledAgent[] = []
  private loaded = false

  async refresh(): Promise<InstalledAgent[]> {
    try {
      this.agents = await listInstalledAgents()
      this.loaded = true
      dispatch('agents-changed', { agents: this.agents })
      return this.agents
    } catch (err) {
      dispatch('error', { message: `Loading agents failed: ${messageFromUnknown(err)}` })
      return this.agents
    }
  }

  getAgents(): InstalledAgent[] {
    return this.agents
  }

  getMeta(agentId: string): AgentMeta | null {
    return this.agents.find((a) => a.agentId === agentId)?.meta ?? null
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** Validates input the same way desktop's add-remote-agent palette does
   *  and persists. Throws on validation failure so a form can surface the
   *  message inline. Does NOT connect — the caller decides when to switch. */
  async add(input: { agentId: string; baseUrl: string; agentToken: string }): Promise<string> {
    const agentId = input.agentId.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/$/, '')
    const agentToken = input.agentToken.trim()
    if (!agentId) throw new Error('Local label is required')
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      throw new Error('Server URL must start with http:// or https://')
    }
    if (!agentToken) throw new Error('Bearer token is required')

    const meta: AgentMeta = { remoteConfig: { baseUrl, agentToken } }
    await setAgentMeta(agentId, meta)
    await addInstalledAgent(agentId)
    await this.refresh()
    return agentId
  }

  async remove(agentId: string): Promise<void> {
    await removeInstalledAgent(agentId)
    await this.refresh()
  }
}

export const agentRegistry = new AgentRegistry()
