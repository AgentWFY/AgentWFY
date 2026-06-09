// Discord-style agent rail. Owns no shared state — listens to the two
// things it actually needs: the installed-agents list and the active
// agent / connection status. Tapping a slot dispatches switch-agent;
// long-press / right-click opens a context menu mirroring desktop's:
// Disconnect (active+connected only) and Remove agent. Tapping + asks
// for the add-agent screen.

import { agentRegistry } from '../services/agent-registry.js'
import { backendSession } from '../services/backend-session.js'
import type { BackendStatusSnapshot } from '#shared/backend/interface.js'
import { dispatch, listen } from '../events.js'
import type { InstalledAgent } from '../agent-meta.js'
import { ICON_PLUG, ICON_PLUS, ICON_TRASH } from './icons.js'
import { displayHost, escapeHtml, requestConfirmation } from './util.js'

export class TlAgentSidebar extends HTMLElement {
  private slotsEl!: HTMLDivElement
  private unsubs: Array<() => void> = []
  private menuEl: HTMLDivElement | null = null

  connectedCallback() {
    this.innerHTML = `
      <aside class="rail">
        <div class="rail-agents" data-role="slots"></div>
        <div class="rail-sep"></div>
        <button type="button" class="rail-add" data-role="add" aria-label="Add agent" title="Add agent">${ICON_PLUS}</button>
      </aside>
    `
    this.slotsEl = this.querySelector<HTMLDivElement>('[data-role="slots"]')!
    this.querySelector<HTMLButtonElement>('[data-role="add"]')!.addEventListener('click', () => {
      this.hideMenu()
      dispatch('set-screen', { screen: 'add-agent' })
    })

    this.unsubs.push(
      listen('agents-changed', ({ agents }) => this.renderSlots(agents)),
      listen('agent-switched', () => this.renderSlots(agentRegistry.getAgents())),
      listen('status-changed', ({ status }) => this.patchStatus(status)),
    )
    this.renderSlots(agentRegistry.getAgents())

    document.addEventListener('pointerdown', this.onDocPointerDown, true)
    window.addEventListener('scroll', this.hideMenu, true)
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
    document.removeEventListener('pointerdown', this.onDocPointerDown, true)
    window.removeEventListener('scroll', this.hideMenu, true)
    this.hideMenu()
  }

  private onDocPointerDown = (evt: Event) => {
    if (!this.menuEl) return
    const target = evt.target as Node
    if (this.menuEl.contains(target)) return
    this.hideMenu()
  }

  private renderSlots(agents: InstalledAgent[]) {
    this.hideMenu()
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
      bindContextMenu(btn, agentId, this)
    })
  }

  private patchStatus(status: BackendStatusSnapshot): void {
    const activeAgentId = backendSession.getActiveAgentId()
    this.slotsEl.querySelectorAll<HTMLDivElement>('.rail-slot').forEach((slot) => {
      const agentId = slot.querySelector<HTMLButtonElement>('[data-agent-id]')?.dataset.agentId ?? null
      const isActive = agentId !== null && agentId === activeAgentId
      slot.classList.toggle('is-active', isActive)
      slot.dataset.status = isActive ? status.state : 'disconnected'
    })
  }

  showMenu(agentId: string, anchor: HTMLElement): void {
    this.hideMenu()
    // BackendSession only clears activeAgentId when disconnect() runs or the
    // initial connect throws — while a retry timer is in flight after a
    // dropped socket, activeAgentId is still set. Gating on isActive alone
    // (not the current status.state) lets the user stop that retry loop
    // without removing the agent profile.
    const activeAgentId = backendSession.getActiveAgentId()
    const isActive = activeAgentId === agentId
    const canDisconnect = isActive

    const menu = document.createElement('div')
    menu.className = 'rail-menu'
    let html = ''
    if (canDisconnect) {
      html += `<button type="button" class="rail-menu-item" data-action="disconnect">${ICON_PLUG}<span>Disconnect</span></button>`
    }
    html += `<button type="button" class="rail-menu-item danger" data-action="remove">${ICON_TRASH}<span>Remove agent</span></button>`
    menu.innerHTML = html

    document.body.appendChild(menu)

    const rect = anchor.getBoundingClientRect()
    const railRect = this.getBoundingClientRect()
    const menuWidth = menu.offsetWidth
    const menuHeight = menu.offsetHeight
    let left = railRect.right + 6
    let top = rect.top + rect.height / 2 - menuHeight / 2
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8
    }
    if (top < 8) top = 8
    if (top + menuHeight > window.innerHeight - 8) {
      top = window.innerHeight - menuHeight - 8
    }
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`

    menu.querySelector<HTMLButtonElement>('[data-action="disconnect"]')?.addEventListener('click', () => {
      this.hideMenu()
      dispatch('disconnect-agent', { agentId })
    })
    menu.querySelector<HTMLButtonElement>('[data-action="remove"]')?.addEventListener('click', () => {
      this.hideMenu()
      void this.confirmRemoveAgent(agentId)
    })

    this.menuEl = menu
  }

  private async confirmRemoveAgent(agentId: string): Promise<void> {
    const confirmed = await requestConfirmation({
      title: 'Remove agent',
      message: `Remove "${agentId}" from this device?`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (confirmed) dispatch('remove-agent', { agentId })
  }

  hideMenu = (): void => {
    if (this.menuEl) {
      this.menuEl.remove()
      this.menuEl = null
    }
  }
}

function bindContextMenu(btn: HTMLButtonElement, agentId: string, sidebar: TlAgentSidebar): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let triggered = false
  let startX = 0
  let startY = 0
  const start = (evt: PointerEvent) => {
    triggered = false
    startX = evt.clientX
    startY = evt.clientY
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = setTimeout(() => {
      triggered = true
      sidebar.showMenu(agentId, btn)
    }, 500)
  }
  const cancel = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
  }
  btn.addEventListener('pointerdown', start)
  btn.addEventListener('pointerup', cancel)
  btn.addEventListener('pointerleave', cancel)
  btn.addEventListener('pointercancel', cancel)
  btn.addEventListener('pointermove', (evt: PointerEvent) => {
    // Cancel the long-press if the pointer drifts — keeps scrolling smooth
    // and stops accidental menus during a flick.
    if (Math.abs(evt.clientX - startX) > 6 || Math.abs(evt.clientY - startY) > 6) cancel()
  })
  // Suppress the tap that follows a long-press so we don't switch agents.
  btn.addEventListener('click', (evt) => {
    if (!triggered) return
    evt.stopImmediatePropagation()
    evt.preventDefault()
    triggered = false
  }, true)
  // Mouse / trackpad right-click on the agent icon — match desktop's
  // context-menu gesture. Suppress the browser default either way so iOS
  // Safari doesn't double-trigger alongside the long-press timer.
  btn.addEventListener('contextmenu', (evt) => {
    evt.preventDefault()
    cancel()
    sidebar.showMenu(agentId, btn)
  })
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

function getInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (name.length >= 2) return name.slice(0, 2).toUpperCase()
  return name.toUpperCase() || '?'
}
