// Session picker body: scrollable list of past sessions + "New session"
// CTA. On mount, asks the backend to refresh the sessions list. Listens
// for sessions-listed / session-created / session-removed /
// providers-changed / status-changed and updates accordingly.
//
// Tapping a row dispatches open-session; tapping the CTA dispatches
// start-draft under the daemon's default provider.

import { backendSession, sortSessions } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import type { ProviderState, SessionSummary } from '#shared/backend/interface.js'
import type { BackendStatusSnapshot } from '#shared/backend/interface.js'
import { ICON_PLUS_SM, ICON_TRASH } from './icons.js'
import { escapeHtml, formatRelative, requestConfirmation } from './util.js'

export class TlSessionList extends HTMLElement {
  private listEl!: HTMLDivElement
  private newBtn!: HTMLButtonElement
  private sessions: SessionSummary[] = []
  private providers: ProviderState | null = backendSession.getProviders()
  private status: BackendStatusSnapshot = backendSession.getStatus()
  private unsubs: Array<() => void> = []

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
      const providerId = defaultDraftProviderId(this.providers)
      if (providerId) dispatch('start-draft', { providerId })
    })

    this.unsubs.push(
      listen('sessions-listed', ({ sessions }) => {
        this.sessions = sessions
        this.render()
      }),
      listen('session-created', ({ summary }) => {
        const filtered = this.sessions.filter((s) => s.sessionId !== summary.sessionId)
        this.sessions = sortSessions([summary, ...filtered])
        this.render()
      }),
      listen('session-removed', ({ sessionId }) => {
        this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId)
        this.render()
      }),
      listen('providers-changed', ({ providers }) => {
        this.providers = providers
        this.updateNewBtn()
      }),
      listen('status-changed', ({ status }) => {
        this.status = status
        this.updateNewBtn()
      }),
      listen('agent-switched', () => {
        this.sessions = []
        this.render()
        void backendSession.refreshSessions()
      }),
    )

    void backendSession.refreshSessions()
    this.render()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  private render() {
    this.listEl.innerHTML = renderRowsHtml(this.sessions)
    this.bindRowHandlers()
    this.updateNewBtn()
  }

  private updateNewBtn() {
    const reason = this.newSessionDisabledReason()
    this.newBtn.disabled = reason !== null
    this.newBtn.title = reason ?? 'Start a new session'
  }

  private newSessionDisabledReason(): string | null {
    if (this.status.state !== 'connected') {
      return this.status.message || 'Remote agent is disconnected.'
    }
    if (!this.providers) return 'Loading providers…'
    if (this.providers.providerList.length === 0) {
      return 'No providers are configured on this daemon.'
    }
    return null
  }

  private bindRowHandlers() {
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sid = btn.dataset.sessionId!
        dispatch('open-session', { sessionId: sid })
      })
    })
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation()
        const id = btn.dataset.sessionId!
        const t = this.sessions.find((s) => s.sessionId === id)
        const label = t?.title || 'this session'
        void this.confirmRemoveSession(id, label)
      })
    })
  }

  private async confirmRemoveSession(sessionId: string, title: string): Promise<void> {
    const confirmed = await requestConfirmation({
      title: 'Remove session',
      message: `Remove "${title}"?`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (confirmed) dispatch('remove-session', { sessionId })
  }
}

function defaultDraftProviderId(providers: ProviderState | null): string | null {
  if (!providers || providers.providerList.length === 0) return null
  const def = providers.providerList.find((p) => p.id === providers.defaultProviderId)
  return def ? def.id : providers.providerList[0].id
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
