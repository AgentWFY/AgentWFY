// Discord-style agent rail on the left of the shell. Mirrors desktop's
// awfy-agent-sidebar — same purpose (switch between installed agents),
// adapted for touch (long-press to remove). Hidden when the shell is in
// `.is-fullscreen` mode (see [[feedback-mobile-rail-visibility]]).

import { controller } from '../controller.js'
import type { AppState, InstalledAgent } from '../app-state.js'
import { ICON_PLUS } from './icons.js'
import { displayHost, escapeHtml } from './util.js'

export class TlAgentSidebar extends HTMLElement {
  private slotsEl!: HTMLDivElement
  private unsubscribe: (() => void) | null = null

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
      controller.setScreen('add-agent')
    })

    this.unsubscribe = controller.subscribe((state) => this.renderSlots(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private renderSlots(state: AppState) {
    if (state.agents.length === 0) {
      this.slotsEl.innerHTML = ''
      return
    }
    this.slotsEl.innerHTML = state.agents.map((a) => renderSlot(a, state)).join('')
    this.slotsEl.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
      const agentId = btn.dataset.agentId!
      btn.addEventListener('click', () => {
        const isActive = controller.getState().activeAgentId === agentId
        if (!isActive) {
          void controller.connect(agentId)
        } else if (controller.getState().screen !== 'chat' && controller.getState().screen !== 'views') {
          controller.setScreen('chat')
        }
      })
      bindLongPressRemove(btn, agentId)
    })
  }
}

function renderSlot(agent: InstalledAgent, state: AppState): string {
  const isActive = state.activeAgentId === agent.agentId
  const activeClass = isActive ? ' is-active' : ''
  const status = isActive ? state.status.state : 'disconnected'
  const initials = getInitials(agent.agentId)
  return `
    <div class="rail-slot${activeClass}" data-status="${status}">
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
      void controller.removeAgent(agentId)
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
