// Discord-style agent rail. Owns no shared state — listens to the two
// things it actually needs: the installed-agents list and the active
// agent / connection status. Tapping a slot dispatches switch-agent;
// long-press dispatches remove-agent; tapping + asks for the add-agent
// screen.

import { agentRegistry } from '../services/agent-registry.js'
import { backendSession } from '../services/backend-session.js'
import type { BackendStatusSnapshot } from '#shared/backend/interface.js'
import { dispatch, listen } from '../events.js'
import type { InstalledAgent } from '../agent-meta.js'
import { ICON_PLUS } from './icons.js'
import { displayHost, escapeHtml } from './util.js'

export class TlAgentSidebar extends HTMLElement {
  private slotsEl!: HTMLDivElement
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.innerHTML = `
      <aside class="rail">
        <div class="rail-brand" aria-hidden="true">A</div>
        <div class="rail-sep"></div>
        <div class="rail-agents" data-role="slots"></div>
        <div class="rail-sep"></div>
        <button type="button" class="rail-add" data-role="add" aria-label="Add agent" title="Add agent">${ICON_PLUS}</button>
      </aside>
    `
    this.slotsEl = this.querySelector<HTMLDivElement>('[data-role="slots"]')!
    this.querySelector<HTMLButtonElement>('[data-role="add"]')!.addEventListener('click', () => {
      dispatch('set-screen', { screen: 'add-agent' })
    })

    this.unsubs.push(
      listen('agents-changed', ({ agents }) => this.renderSlots(agents)),
      listen('agent-switched', () => this.renderSlots(agentRegistry.getAgents())),
      listen('status-changed', () => this.renderSlots(agentRegistry.getAgents())),
    )
    this.renderSlots(agentRegistry.getAgents())
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  private renderSlots(agents: InstalledAgent[]) {
    if (agents.length === 0) {
      this.slotsEl.innerHTML = ''
      return
    }
    const activeAgentId = backendSession.getActiveAgentId()
    const status = backendSession.getStatus()
    this.slotsEl.innerHTML = agents.map((a) => renderSlot(a, activeAgentId, status)).join('')
    this.slotsEl.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
      const agentId = btn.dataset.agentId!
      btn.addEventListener('click', () => {
        if (backendSession.getActiveAgentId() !== agentId) {
          dispatch('switch-agent', { agentId })
        } else {
          dispatch('set-screen', { screen: 'chat' })
        }
      })
      bindLongPressRemove(btn, agentId)
    })
  }
}

function renderSlot(
  agent: InstalledAgent,
  activeAgentId: string | null,
  status: BackendStatusSnapshot,
): string {
  const isActive = activeAgentId === agent.agentId
  const activeClass = isActive ? ' is-active' : ''
  const dotState = isActive ? status.state : 'disconnected'
  const initials = getInitials(agent.agentId)
  return `
    <div class="rail-slot${activeClass}" data-status="${dotState}">
      <span class="rail-indicator"></span>
      <button type="button" class="rail-icon" data-action="connect" data-agent-id="${escapeHtml(agent.agentId)}"
        title="${escapeHtml(agent.agentId)} (${escapeHtml(displayHost(agent.meta.remoteConfig.baseUrl))})"
        aria-label="${escapeHtml(agent.agentId)}">
        ${escapeHtml(initials)}
      </button>
    </div>
  `
}

function bindLongPressRemove(btn: HTMLButtonElement, agentId: string): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  const start = () => {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = setTimeout(() => {
      if (!confirm(`Remove agent "${agentId}"?`)) return
      dispatch('remove-agent', { agentId })
    }, 650)
  }
  const cancel = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }
  btn.addEventListener('pointerdown', start)
  btn.addEventListener('pointerup', cancel)
  btn.addEventListener('pointerleave', cancel)
  btn.addEventListener('pointercancel', cancel)
}

function getInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (name.length >= 2) return name.slice(0, 2).toUpperCase()
  return name.toUpperCase() || '?'
}
