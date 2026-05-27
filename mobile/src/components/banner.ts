// Error / info banner shown under the main-pane header on both the
// add-agent screen and the connected pane. Maintains its own current
// message + tone in local fields, updated from error and status-changed
// events.

import { backendSession } from '../services/backend-session.js'
import { listen } from '../events.js'
import type { BackendStatusSnapshot } from '#shared/backend/interface.js'

export class TlBanner extends HTMLElement {
  private errorMessage: string | null = null
  private status: BackendStatusSnapshot = backendSession.getStatus()
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.className = 'banner hidden'
    this.unsubs.push(
      listen('error', ({ message }) => {
        this.errorMessage = message
        this.update()
      }),
      listen('status-changed', ({ status }) => {
        this.status = status
        this.update()
      }),
      listen('agent-switched', () => {
        this.errorMessage = null
        this.update()
      }),
    )
    this.update()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  private update() {
    const message = this.computeMessage()
    if (message) {
      this.classList.remove('hidden')
      this.textContent = message
      this.dataset.tone = this.computeTone()
    } else {
      this.classList.add('hidden')
      this.textContent = ''
    }
  }

  private computeMessage(): string | null {
    if (this.errorMessage) return this.errorMessage
    if (this.status.state === 'error') return this.status.message || 'Connection error.'
    return null
  }

  private computeTone(): string {
    return this.status.state === 'error' || this.errorMessage ? 'error' : 'info'
  }
}
