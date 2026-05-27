// Provider selection grid shown on the draft compose screen. Receives a
// `selected-id` attribute from the parent so the highlighted card matches
// the active draft provider. Listens for providers-changed; tapping a
// card dispatches start-draft so the router-shell swaps draftProviderId.

import { backendSession } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import type { ProviderState } from '#shared/backend/interface.js'
import { escapeHtml } from './util.js'

export class TlProviderGrid extends HTMLElement {
  static get observedAttributes() { return ['selected-id'] }

  private providers: ProviderState | null = backendSession.getProviders()
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.className = 'provider-grid'
    this.unsubs.push(
      listen('providers-changed', ({ providers }) => {
        this.providers = providers
        this.render()
      }),
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
    const providers = this.providers
    if (!providers || providers.providerList.length === 0) {
      this.innerHTML = `<div class="empty-list">No providers configured.</div>`
      return
    }
    const selectedId = this.getAttribute('selected-id')
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
        dispatch('start-draft', { providerId: id })
      })
    })
  }
}
