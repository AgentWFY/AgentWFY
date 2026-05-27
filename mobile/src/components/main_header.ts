// Top bar of the main pane. Parent (<awfy-app>) sets the kind +
// session/view/agent attributes; this component listens for status changes
// and session-state/sessions-listed/db-change to derive the displayed
// title and status dot. Buttons dispatch intent events back up.

import { backendSession } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import { bridge } from '../tauri-bridge.js'
import type { BackendStatusSnapshot, SessionSummary } from '#shared/backend/interface.js'
import { ICON_BACK, ICON_KEBAB, ICON_REFRESH, ICON_TRASH } from './icons.js'
import { escapeHtml } from './util.js'

type HeaderKind = 'picker' | 'session' | 'draft' | 'view'

export class TlMainHeader extends HTMLElement {
  static get observedAttributes() {
    return ['kind', 'session-id', 'view-name', 'agent-id']
  }

  private currentKind: HeaderKind | null = null
  private titleEl: HTMLHeadingElement | null = null
  private statusDotEl: HTMLSpanElement | null = null
  private menuListEl: HTMLDivElement | null = null
  private unsubs: Array<() => void> = []
  /** Cached so we can resolve a session title without an extra await when
   *  the kind flips to 'session' for a session we just opened. */
  private knownSessionTitles = new Map<string, string>()
  /** Cached so we can resolve a view title. Populated from db-change
   *  events targeting the views table, plus an initial query on mount. */
  private knownViewTitles = new Map<string, string>()

  connectedCallback() {
    this.className = 'main-header-host'
    this.unsubs.push(
      listen('status-changed', () => this.patchStatusDot()),
      listen('session-state', ({ sessionId, title }) => {
        if (title !== undefined && title !== null) this.knownSessionTitles.set(sessionId, title)
        this.patchTitle()
      }),
      listen('sessions-listed', ({ sessions }) => {
        this.indexSessions(sessions)
        this.patchTitle()
      }),
      listen('db-change', ({ change }) => {
        if (change.table === 'views') {
          void this.refreshViewTitles().then(() => this.patchTitle())
        }
      }),
      listen('snapshot-applied', () => {
        void this.refreshViewTitles().then(() => this.patchTitle())
      }),
      listen('agent-switched', () => {
        this.knownSessionTitles.clear()
        this.knownViewTitles.clear()
        void this.refreshViewTitles().then(() => this.patchTitle())
      }),
    )

    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('touchstart', this.onDocumentClick, { passive: true })

    void this.refreshViewTitles()
    this.render()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('touchstart', this.onDocumentClick)
  }

  attributeChangedCallback(name: string) {
    if (!this.isConnected) return
    if (name === 'kind') this.render()
    else this.patchTitle()
  }

  private onDocumentClick = (evt: Event) => {
    if (!this.menuListEl || this.menuListEl.classList.contains('hidden')) return
    const target = evt.target as HTMLElement | null
    if (target && (target.closest('[data-role="menu"]') === this.menuListEl
                || target.closest('[data-role="menu-btn"]')?.closest('awfy-main-header') === this)) {
      return
    }
    this.menuListEl.classList.add('hidden')
  }

  private get kind(): HeaderKind {
    const v = this.getAttribute('kind')
    if (v === 'session' || v === 'draft' || v === 'view') return v
    return 'picker'
  }

  private render() {
    const kind = this.kind
    if (this.currentKind === kind) {
      this.patchTitle()
      this.patchStatusDot()
      return
    }
    this.currentKind = kind
    this.innerHTML = headerHtml(kind, this.getStatus())
    this.titleEl = this.querySelector<HTMLHeadingElement>('[data-role="title"]')
    this.statusDotEl = this.querySelector<HTMLSpanElement>('[data-role="status-dot"]')
    this.menuListEl = this.querySelector<HTMLDivElement>('[data-role="menu"]')

    this.querySelector<HTMLButtonElement>('[data-role="back"]')?.addEventListener('click', () => {
      if (this.getAttribute('session-id')) dispatch('close-session')
      else if (kind === 'draft') dispatch('cancel-draft')
      else if (this.getAttribute('view-name')) dispatch('close-view')
    })

    this.querySelector<HTMLButtonElement>('[data-role="reload"]')?.addEventListener('click', () => {
      dispatch('reload-view')
    })

    const menuBtn = this.querySelector<HTMLButtonElement>('[data-role="menu-btn"]')
    menuBtn?.addEventListener('click', (evt) => {
      evt.stopPropagation()
      this.menuListEl?.classList.toggle('hidden')
    })

    this.querySelector<HTMLButtonElement>('[data-role="remove-agent"]')?.addEventListener('click', () => {
      this.menuListEl?.classList.add('hidden')
      const agentId = this.getAttribute('agent-id')
      if (!agentId) return
      if (!confirm(`Remove agent "${agentId}"?`)) return
      dispatch('remove-agent', { agentId })
    })

    this.querySelector<HTMLButtonElement>('[data-role="remove-session"]')?.addEventListener('click', () => {
      this.menuListEl?.classList.add('hidden')
      const sessionId = this.getAttribute('session-id')
      if (!sessionId) return
      const title = this.knownSessionTitles.get(sessionId) || 'Untitled session'
      if (!confirm(`Remove session "${title}"?`)) return
      dispatch('remove-session', { sessionId })
    })

    this.patchTitle()
  }

  private patchTitle() {
    if (!this.titleEl) return
    const kind = this.kind
    if (kind === 'session') {
      const sid = this.getAttribute('session-id') ?? ''
      this.titleEl.textContent = this.knownSessionTitles.get(sid) || 'Chat'
    } else if (kind === 'draft') {
      this.titleEl.textContent = 'New session'
    } else if (kind === 'view') {
      const name = this.getAttribute('view-name') ?? ''
      this.titleEl.textContent = this.knownViewTitles.get(name) || name || 'View'
    } else {
      this.titleEl.textContent = this.getAttribute('agent-id') ?? ''
    }
  }

  private patchStatusDot() {
    if (!this.statusDotEl) return
    const status = this.getStatus()
    this.statusDotEl.dataset.state = status.state
    this.statusDotEl.title = formatStatus(status)
  }

  private getStatus(): BackendStatusSnapshot { return backendSession.getStatus() }

  private indexSessions(sessions: SessionSummary[]) {
    for (const s of sessions) {
      if (s.title) this.knownSessionTitles.set(s.sessionId, s.title)
    }
  }

  private async refreshViewTitles(): Promise<void> {
    const backend = backendSession.getBackend()
    if (!backend) return
    const agentId = backendSession.getActiveAgentId()
    if (!agentId) return
    // Pull the same rows agent-shell uses to render the view list. Done here
    // because main_header is the only component that needs a title→name
    // mapping; mirroring the query keeps both surfaces in sync.
    try {
      const rows = await bridge.mirrorDb.query(
        agentId,
        `SELECT name, title FROM views`,
      )
      // The active agent may have changed during the await. If it did,
      // discard these rows — they belong to the previous agent and would
      // poison the title cache otherwise.
      if (backendSession.getActiveAgentId() !== agentId) return
      this.knownViewTitles.clear()
      for (const row of rows) {
        const name = String(row.name ?? '')
        const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : ''
        if (name && title) this.knownViewTitles.set(name, title)
      }
    } catch {
      // Mirror DB might not be open yet (initial snapshot in flight) — the
      // db-change/snapshot-applied listeners will retry once it's ready.
    }
  }
}

function headerHtml(kind: HeaderKind, status: BackendStatusSnapshot): string {
  const statusAttrs = `data-state="${status.state}" title="${escapeHtml(formatStatus(status))}"`
  switch (kind) {
    case 'picker':
      return `
        <header class="main-header">
          <div class="main-header-title">
            <h1 data-role="title"></h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" ${statusAttrs}></span>
            <button type="button" class="icon-btn" data-role="menu-btn" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
            <div class="menu hidden" data-role="menu">
              <button type="button" class="menu-item danger" data-role="remove-agent">${ICON_TRASH}<span>Remove agent</span></button>
            </div>
          </div>
        </header>
      `
    case 'session':
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Back" title="Back">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title"></h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" ${statusAttrs}></span>
            <button type="button" class="icon-btn" data-role="menu-btn" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
            <div class="menu hidden" data-role="menu">
              <button type="button" class="menu-item danger" data-role="remove-session">${ICON_TRASH}<span>Remove session</span></button>
            </div>
          </div>
        </header>
      `
    case 'draft':
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Cancel" title="Cancel">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title">New session</h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" ${statusAttrs}></span>
          </div>
        </header>
      `
    case 'view':
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Back" title="Back">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title"></h1>
          </div>
          <div class="main-header-actions">
            <button type="button" class="icon-btn" data-role="reload" aria-label="Reload" title="Reload">${ICON_REFRESH}</button>
          </div>
        </header>
      `
  }
}

export function formatStatus(status: BackendStatusSnapshot): string {
  if (status.state === 'disconnected' && status.updatedAt === 0) return 'Idle'
  return `${capitalize(status.state)}${status.message ? ` — ${status.message}` : ''}`
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}
