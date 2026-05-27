// Session picker body: scrollable list of past sessions + "New session"
// CTA. Tapping a row loads that session into activeSession; tapping the CTA
// starts a draft under the daemon's default provider.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import type { ProviderState, SessionSummary } from '#shared/backend/interface.js'
import { ICON_PLUS_SM, ICON_TRASH } from './icons.js'
import { escapeHtml, formatRelative } from './util.js'

export class TlSessionList extends HTMLElement {
  private listEl!: HTMLDivElement
  private newBtn!: HTMLButtonElement
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.innerHTML = `
      <div class="scroll-list" data-role="list"></div>
      <div class="picker-actions">
        <button type="button" class="btn primary" data-role="new">
          ${ICON_PLUS_SM}<span>New session</span>
        </button>
      </div>
    `
    this.listEl = this.querySelector<HTMLDivElement>('[data-role="list"]')!
    this.newBtn = this.querySelector<HTMLButtonElement>('[data-role="new"]')!
    this.newBtn.addEventListener('click', () => {
      if (this.newBtn.disabled) return
      const providerId = defaultDraftProviderId(controller.getState().providers)
      if (providerId) controller.startDraft(providerId)
    })

    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    this.listEl.innerHTML = renderRowsHtml(state.sessions)
    this.bindRowHandlers(state.sessions)

    const reason = newSessionDisabledReason(state)
    this.newBtn.disabled = reason !== null
    this.newBtn.title = reason ?? 'Start a new session'
  }

  private bindRowHandlers(sessions: SessionSummary[]) {
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void controller.loadSession(btn.dataset.sessionId!)
      })
    })
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation()
        const id = btn.dataset.sessionId!
        const t = sessions.find((s) => s.sessionId === id)
        if (!t) return
        const label = t.title || 'this session'
        if (!confirm(`Remove session "${label}"?`)) return
        void controller.removeSession(id)
      })
    })
  }
}

function defaultDraftProviderId(providers: ProviderState | null): string | null {
  if (!providers || providers.providerList.length === 0) return null
  const def = providers.providerList.find((p) => p.id === providers.defaultProviderId)
  return def ? def.id : providers.providerList[0].id
}

function newSessionDisabledReason(state: AppState): string | null {
  if (state.status.state !== 'connected') {
    return state.status.message || 'Remote agent is disconnected.'
  }
  if (!state.providers) return 'Loading providers…'
  if (state.providers.providerList.length === 0) {
    return 'No providers are configured on this daemon.'
  }
  return null
}

function renderRowsHtml(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return `<div class="empty-list">No sessions yet. Send a message to start one.</div>`
  }
  return sessions.map(renderRow).join('')
}

function renderRow(s: SessionSummary): string {
  const title = s.title || 'Untitled session'
  return `
    <div class="row">
      <button type="button" class="row-main" data-action="open" data-session-id="${escapeHtml(s.sessionId)}">
        <span class="row-title">${escapeHtml(title)}</span>
        <span class="row-meta">${escapeHtml(s.providerId || '—')} · ${escapeHtml(formatRelative(s.updatedAt))}</span>
      </button>
      <button type="button" class="row-action" data-action="remove" data-session-id="${escapeHtml(s.sessionId)}" aria-label="Remove session" title="Remove">
        ${ICON_TRASH}
      </button>
    </div>
  `
}
