// Status line shown below the composer. Reports retry/stall state when the
// active session has live work, the selected draft provider's status line
// for a fresh draft, or a plain "Ready" otherwise.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import type { RetryState } from '#shared/agent/types.js'
import { formatDuration } from './util.js'

export class TlLiveStatus extends HTMLElement {
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.className = 'composer-status'
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const live = state.activeSession?.live
    if (state.status.state !== 'connected') {
      this.dataset.tone = 'error'
      this.textContent = state.status.message || 'Disconnected'
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
    if (!state.activeSession && state.draftProviderId !== null) {
      const lines = new Map(state.providers?.providerStatusLines ?? [])
      this.textContent = lines.get(state.draftProviderId) || ''
      return
    }
    this.textContent = 'Ready'
  }
}

function formatRetry(retry: RetryState): string {
  const delay = Math.max(0, retry.nextRetryAt - Date.now())
  return `Retrying in ${formatDuration(delay)} (attempt ${retry.attempt}/${retry.maxAttempts}): ${retry.lastError}`
}
