// Provider selection grid shown on the draft compose screen. Matches the
// desktop awfy-provider-grid role. Tapping a card swaps draftProviderId
// (controller.startDraft) so the next sendMessage spawns under that
// provider.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import { escapeHtml } from './util.js'

export class TlProviderGrid extends HTMLElement {
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.className = 'provider-grid'
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const providers = state.providers
    if (!providers || providers.providerList.length === 0) {
      this.innerHTML = `<div class="empty-list">No providers configured.</div>`
      return
    }
    const selectedId = state.draftProviderId
    const statusLines = new Map(providers.providerStatusLines)
    this.innerHTML = providers.providerList.map((p) => {
      const isSelected = p.id === selectedId
      const isDefault = p.id === providers.defaultProviderId
      const status = statusLines.get(p.id) || ''
      return `
        <button type="button"
                class="provider-card${isSelected ? ' selected' : ''}"
                data-provider-id="${escapeHtml(p.id)}">
          <span class="provider-card-name">${escapeHtml(p.name)}</span>
          <span class="provider-card-status">${escapeHtml(status)}</span>
          ${isDefault ? `<span class="provider-card-badge">default</span>` : ''}
        </button>
      `
    }).join('')

    this.querySelectorAll<HTMLButtonElement>('.provider-card[data-provider-id]').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.providerId
        if (!id || id === selectedId) return
        controller.startDraft(id)
      })
    })
  }
}
