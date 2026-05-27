// Status line shown below the composer. Reads its data from three
// independent sources:
//   • `live` attribute mirrored by the parent (agent_chat) with the
//     current SessionLivePatch — empty for drafts
//   • status-changed events (disconnected/error overrides)
//   • providers-changed events (provider-specific status line for the
//     current draft, looked up from a draft-provider-id attribute set by
//     awfy-draft-compose via awfy-chat-input ancestry — but we accept it
//     simpler: just read the same providers map and try to find a hint)
//
// Pure presentation; no actions.

import { backendSession } from '../services/backend-session.js'
import { listen } from '../events.js'
import type { BackendStatusSnapshot, ProviderState, SessionLivePatch } from '#shared/backend/interface.js'
import type { RetryState } from '#shared/agent/types.js'
import { formatDuration } from './util.js'

export class TlLiveStatus extends HTMLElement {
  static get observedAttributes() { return ['live', 'draft-provider-id'] }

  private status: BackendStatusSnapshot = backendSession.getStatus()
  private providers: ProviderState | null = backendSession.getProviders()
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.className = 'composer-status'
    this.unsubs.push(
      listen('status-changed', ({ status }) => { this.status = status; this.render() }),
      listen('providers-changed', ({ providers }) => { this.providers = providers; this.render() }),
    )
    this.render()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render()
  }

  private render() {
    const live = this.readLive()
    if (this.status.state !== 'connected') {
      this.dataset.tone = 'error'
      this.textContent = this.status.message || 'Disconnected'
      return
    }
    if (live?.retryState) {
      this.dataset.tone = 'warn'
      this.textContent = formatRetry(live.retryState)
      return
    }
    if (live?.stalledSince) {
      this.dataset.tone = 'warn'
      this.textContent = `No response for ${formatDuration(Date.now() - live.stalledSince)}.`
      return
    }
    delete this.dataset.tone
    if (live?.statusLine) {
      this.textContent = live.statusLine
      return
    }
    if (live?.isStreaming) {
      this.textContent = 'Streaming response…'
      return
    }
    const draftProviderId = this.getAttribute('draft-provider-id')
    if (draftProviderId) {
      const lines = new Map(this.providers?.providerStatusLines ?? [])
      this.textContent = lines.get(draftProviderId) || ''
      return
    }
    this.textContent = 'Ready'
  }

  private readLive(): SessionLivePatch | null {
    const raw = this.getAttribute('live')
    if (!raw) return null
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object') return obj as SessionLivePatch
    } catch {
      return null
    }
    return null
  }
}

function formatRetry(retry: RetryState): string {
  const delay = Math.max(0, retry.nextRetryAt - Date.now())
  return `Retrying in ${formatDuration(delay)} (attempt ${retry.attempt}/${retry.maxAttempts}): ${retry.lastError}`
}
