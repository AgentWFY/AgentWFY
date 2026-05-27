// The top bar of the main pane. Shape depends on what's in the body:
//
//   • picker (chat tab session list, views tab view list):
//       agent name | status dot | kebab menu (Remove agent)
//   • active session:
//       back | session title | status dot | kebab menu (Remove session)
//   • draft:
//       back | "New session" | status dot
//   • view frame:
//       back | view title | reload
//
// Implemented as a single element that re-renders its DOM when the "kind"
// changes; in-place patches for title and status dot when only those change.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import { formatStatus } from './banner.js'
import { ICON_BACK, ICON_KEBAB, ICON_REFRESH, ICON_TRASH } from './icons.js'
import { escapeHtml } from './util.js'

type HeaderKind = 'picker' | 'session' | 'draft' | 'view'

export class TlMainHeader extends HTMLElement {
  private currentKind: HeaderKind | null = null
  private titleEl: HTMLHeadingElement | null = null
  private statusDotEl: HTMLSpanElement | null = null
  private menuListEl: HTMLDivElement | null = null
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.className = 'main-header-host'
    this.unsubscribe = controller.subscribe((state) => this.update(state))
    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('touchstart', this.onDocumentClick, { passive: true })
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('touchstart', this.onDocumentClick)
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

  private update(state: AppState) {
    const kind = headerKind(state)
    if (kind !== this.currentKind) {
      this.currentKind = kind
      this.renderShell(kind, state)
    }
    this.patchTitle(state)
    this.patchStatusDot(state)
  }

  private renderShell(kind: HeaderKind, state: AppState) {
    this.innerHTML = headerHtml(kind, state)
    this.titleEl = this.querySelector<HTMLHeadingElement>('[data-role="title"]')
    this.statusDotEl = this.querySelector<HTMLSpanElement>('[data-role="status-dot"]')
    this.menuListEl = this.querySelector<HTMLDivElement>('[data-role="menu"]')

    this.querySelector<HTMLButtonElement>('[data-role="back"]')?.addEventListener('click', () => {
      const s = controller.getState()
      if (s.activeSession) controller.closeSession()
      else if (s.draftProviderId !== null) controller.cancelDraft()
      else if (s.activeViewName) controller.closeView()
    })

    this.querySelector<HTMLButtonElement>('[data-role="reload"]')?.addEventListener('click', () => {
      controller.reloadView()
    })

    const menuBtn = this.querySelector<HTMLButtonElement>('[data-role="menu-btn"]')
    menuBtn?.addEventListener('click', (evt) => {
      evt.stopPropagation()
      this.menuListEl?.classList.toggle('hidden')
    })

    this.querySelector<HTMLButtonElement>('[data-role="remove-agent"]')?.addEventListener('click', async () => {
      this.menuListEl?.classList.add('hidden')
      const agentId = controller.getState().activeAgentId
      if (!agentId) return
      if (!confirm(`Remove agent "${agentId}"?`)) return
      await controller.removeAgent(agentId)
    })

    this.querySelector<HTMLButtonElement>('[data-role="remove-session"]')?.addEventListener('click', () => {
      this.menuListEl?.classList.add('hidden')
      const current = controller.getState().activeSession
      if (!current) return
      const label = current.title || 'Untitled session'
      if (!confirm(`Remove session "${label}"?`)) return
      void controller.removeSession(current.sessionId)
    })
  }

  private patchTitle(state: AppState) {
    if (!this.titleEl) return
    if (state.activeSession) {
      this.titleEl.textContent = state.activeSession.title || 'Chat'
    } else if (state.draftProviderId !== null) {
      this.titleEl.textContent = 'New session'
    } else if (state.activeViewName) {
      const view = state.views.find((v) => v.name === state.activeViewName)
      this.titleEl.textContent = view?.title || state.activeViewName
    } else if (state.activeAgentId) {
      this.titleEl.textContent = state.activeAgentId
    }
  }

  private patchStatusDot(state: AppState) {
    if (!this.statusDotEl) return
    this.statusDotEl.dataset.state = state.status.state
    this.statusDotEl.title = formatStatus(state)
  }
}

function headerKind(state: AppState): HeaderKind {
  if (state.screen === 'views') return state.activeViewName ? 'view' : 'picker'
  if (state.activeSession) return 'session'
  if (state.draftProviderId !== null) return 'draft'
  return 'picker'
}

function headerHtml(kind: HeaderKind, state: AppState): string {
  switch (kind) {
    case 'picker':
      return `
        <header class="main-header">
          <div class="main-header-title">
            <h1 data-role="title">${escapeHtml(state.activeAgentId ?? '')}</h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
            <button type="button" class="icon-btn" data-role="menu-btn" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
            <div class="menu hidden" data-role="menu">
              <button type="button" class="menu-item danger" data-role="remove-agent">${ICON_TRASH}<span>Remove agent</span></button>
            </div>
          </div>
        </header>
      `
    case 'session': {
      const title = state.activeSession?.title || 'Chat'
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Back" title="Back">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title">${escapeHtml(title)}</h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
            <button type="button" class="icon-btn" data-role="menu-btn" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
            <div class="menu hidden" data-role="menu">
              <button type="button" class="menu-item danger" data-role="remove-session">${ICON_TRASH}<span>Remove session</span></button>
            </div>
          </div>
        </header>
      `
    }
    case 'draft':
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Cancel" title="Cancel">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title">New session</h1>
          </div>
          <div class="main-header-actions">
            <span class="status-dot" data-role="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
          </div>
        </header>
      `
    case 'view': {
      const view = state.views.find((v) => v.name === state.activeViewName)
      const title = view?.title || state.activeViewName || 'View'
      return `
        <header class="main-header">
          <button type="button" class="icon-btn back-btn" data-role="back" aria-label="Back" title="Back">${ICON_BACK}</button>
          <div class="main-header-title">
            <h1 data-role="title">${escapeHtml(title)}</h1>
          </div>
          <div class="main-header-actions">
            <button type="button" class="icon-btn" data-role="reload" aria-label="Reload" title="Reload">${ICON_REFRESH}</button>
          </div>
        </header>
      `
    }
  }
}
