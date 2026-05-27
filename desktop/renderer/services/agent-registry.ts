import type { InstalledAgent, SidebarSwitchedPayload } from '../ipc-types/index.js'
import { dispatch } from '../events.js'

class AgentRegistry {
  private agents: InstalledAgent[] = []
  private installed = false
  private unlistenSwitched: (() => void) | null = null

  install(): void {
    this.destroy()
    const ipc = window.ipc
    if (!ipc?.agentSidebar) return

    this.unlistenSwitched = ipc.agentSidebar.onSwitched((payload) => {
      this.applySwitched(payload)
    })

    this.installed = true
  }

  destroy(): void {
    this.unlistenSwitched?.()
    this.unlistenSwitched = null
    this.installed = false
  }

  async refresh(): Promise<InstalledAgent[]> {
    const agents = await window.ipc?.agentSidebar?.getInstalled()
    this.agents = Array.isArray(agents) ? agents : []
    dispatch('agents-changed', { agents: this.agents })
    return this.agents
  }

  getAgents(): InstalledAgent[] {
    return this.agents
  }

  isInstalled(): boolean {
    return this.installed
  }

  async switch(agentId: string): Promise<void> {
    await window.ipc?.agentSidebar?.switch(agentId)
  }

  async reorder(fromIndex: number, toIndex: number): Promise<void> {
    await window.ipc?.agentSidebar?.reorder(fromIndex, toIndex)
  }

  async showContextMenu(agentId: string): Promise<void> {
    await window.ipc?.agentSidebar?.showContextMenu(agentId)
  }

  private applySwitched(data: SidebarSwitchedPayload): void {
    this.agents = data.agents
    dispatch('agents-changed', { agents: this.agents })
    dispatch('agent-switched', { agentId: data.agentId, agents: data.agents })
  }
}

export const agentRegistry = new AgentRegistry()
