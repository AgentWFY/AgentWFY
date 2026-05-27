// Error / info banner shown under the main-pane header on both the
// add-agent screen and the connected pane. Hidden when there's nothing to
// say.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'

export class TlBanner extends HTMLElement {
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.className = 'banner hidden'
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const message = bannerMessage(state)
    if (message) {
      this.classList.remove('hidden')
      this.textContent = message
      this.dataset.tone = bannerTone(state)
    } else {
      this.classList.add('hidden')
      this.textContent = ''
    }
  }
}

function bannerMessage(state: AppState): string | null {
  if (state.error) return state.error
  if (state.status.state === 'error') return state.status.message || 'Connection error.'
  return null
}

function bannerTone(state: AppState): string {
  return state.status.state === 'error' || state.error ? 'error' : 'info'
}

export function formatStatus(state: AppState): string {
  if (state.status.state === 'disconnected' && !state.activeAgentId) return 'Idle'
  const base = `${capitalize(state.status.state)}${state.status.message ? ` — ${state.status.message}` : ''}`
  if (state.lastSyncAt !== null) return `${base} · synced`
  return base
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}
