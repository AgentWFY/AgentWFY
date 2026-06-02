// Router-shell. Owns four pieces of UI state locally:
//   screen           — 'add-agent' | 'chat' | 'views'
//   activeSessionId  — non-null while a session is loaded
//   draftProviderId  — non-null while composing a new session
//   activePage       — non-null while a foreground mobile page is open
//
// Listens for the intent events that mutate these fields and re-mounts the
// body component with the right attributes. Toggles .is-fullscreen on
// itself so the agent rail hides during an active session / draft / view
// (see [[feedback-mobile-rail-visibility]]).
//
// This component has no knowledge of the backend, sessions, providers, or
// views — it just routes. Each body component talks to the backend
// service directly and listens to window events for its own concerns.

import { backendSession } from '../services/backend-session.js'
import { dispatch, listen, type Screen } from '../events.js'
import { bridge } from '../tauri-bridge.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import type { PageInfo } from '#shared/page/types.js'

type BodyKind = 'session-list' | 'agent-chat' | 'draft-compose' | 'view-list' | 'view-frame'

const BODY_TAG: Record<BodyKind, string> = {
  'session-list': 'awfy-session-list',
  'agent-chat': 'awfy-agent-chat',
  'draft-compose': 'awfy-draft-compose',
  'view-list': 'awfy-view-list',
  'view-frame': 'awfy-view-frame',
}

export class TlApp extends HTMLElement {
  private shellEl!: HTMLDivElement
  private mainEl!: HTMLElement
  private bodyEl: HTMLDivElement | null = null
  private bottomTabsEl: HTMLElement | null = null
  private currentMainKind: 'add-agent' | 'connected' | null = null
  private currentBodyKind: BodyKind | null = null
  private currentBodyEl: HTMLElement | null = null

  private screen: Screen = 'add-agent'
  private activeSessionId: string | null = null
  private draftProviderId: string | null = null
  private activePage: PageInfo | null = null

  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.shellEl = document.createElement('div')
    this.shellEl.className = 'shell'
    this.shellEl.innerHTML = `<awfy-agent-sidebar></awfy-agent-sidebar><main class="main"></main>`
    this.mainEl = this.shellEl.querySelector<HTMLElement>('main.main')!
    this.appendChild(this.shellEl)

    this.unsubs.push(
      listen('set-screen', ({ screen }) => this.setScreen(screen)),
      listen('agent-switched', ({ agentId }) => this.onAgentSwitched(agentId)),
      listen('agents-changed', ({ agents }) => this.onAgentsChanged(agents.length)),
      listen('open-session', ({ sessionId }) => this.openSession(sessionId)),
      listen('close-session', () => this.closeSession()),
      listen('start-draft', ({ providerId }) => this.startDraft(providerId)),
      listen('cancel-draft', () => this.cancelDraft()),
      listen('open-view', ({ name }) => { void this.openView(name) }),
      listen('close-view', () => { void this.closeView() }),
      listen('reload-view', () => { void this.reloadView() }),
      listen('page-changed', ({ page }) => this.onPageChanged(page)),
      listen('session-created', ({ summary }) => {
        // When the user sends a draft, the new session arrives via this
        // event. Promote the draft to an active session if we were drafting.
        if (this.draftProviderId !== null && this.activeSessionId === null) {
          this.activeSessionId = summary.sessionId
          this.draftProviderId = null
          this.render()
        }
      }),
      listen('session-removed', ({ sessionId }) => {
        if (this.activeSessionId === sessionId) {
          this.activeSessionId = null
          this.render()
        }
      }),
      listen('db-change', ({ change }) => {
        void this.handleActiveViewDbChange(change)
      }),
      listen('snapshot-applied', () => {
        // Snapshot rewrites everything. Per-row delete events don't fire,
        // so we can't tell whether the active view survived the swap
        // without asking the mirror. If it's gone, close it; otherwise
        // reload the iframe.
        if (this.activePage !== null) void this.revalidateActivePage()
      }),
    )

    this.render()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  // ── State transitions ───────────────────────────────────────────────────

  private setScreen(screen: Screen) {
    if (this.screen === screen) return
    this.screen = screen
    this.render()
  }

  private onAgentSwitched(agentId: string | null) {
    // Reset per-agent UI state when the active agent changes so a switch
    // from A→B doesn't briefly show A's session under B's header.
    this.activeSessionId = null
    this.draftProviderId = null
    this.activePage = backendSession.getCurrentClientPage()
    if (agentId !== null && this.screen === 'add-agent') {
      this.screen = 'chat'
    }
    this.render()
  }

  private onAgentsChanged(count: number) {
    if (count === 0) {
      this.screen = 'add-agent'
      this.activeSessionId = null
      this.draftProviderId = null
      this.activePage = null
      this.render()
    }
  }

  private openSession(sessionId: string) {
    this.activeSessionId = sessionId
    this.draftProviderId = null
    this.screen = 'chat'
    this.render()
  }

  private closeSession() {
    if (this.activeSessionId === null) return
    this.activeSessionId = null
    this.render()
  }

  private startDraft(providerId: string) {
    this.draftProviderId = providerId
    this.activeSessionId = null
    this.screen = 'chat'
    this.render()
  }

  private cancelDraft() {
    if (this.draftProviderId === null) return
    this.draftProviderId = null
    this.render()
  }

  private async openView(name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    if (activeViewName(this.activePage) === trimmed) {
      this.screen = 'views'
      this.render()
      return
    }

    const pages = backendSession.getPageTools()
    if (!pages) {
      dispatch('error', { message: 'Remote agent is not connected.' })
      return
    }

    try {
      const result = await pages.openPage({
        display: 'foreground',
        source: { type: 'view', name: trimmed },
        title: trimmed,
        createdBy: 'user',
      })
      this.activePage = result.page
      this.screen = 'views'
      dispatch('error', { message: null })
      this.render()
    } catch (err) {
      dispatch('error', { message: `Opening view failed: ${messageFromUnknown(err)}` })
    }
  }

  private async closeView(): Promise<void> {
    const page = this.activePage
    if (page === null) return
    const pages = backendSession.getPageTools()
    if (!pages) {
      this.activePage = null
      this.render()
      return
    }
    try {
      await pages.closePage({ pageId: page.pageId })
    } catch (err) {
      dispatch('error', { message: `Closing view failed: ${messageFromUnknown(err)}` })
      this.activePage = null
      this.render()
    }
  }

  private async reloadView(): Promise<void> {
    const page = this.activePage
    if (page === null) return
    const pages = backendSession.getPageTools()
    if (!pages) return
    try {
      this.activePage = await pages.reloadPage({ pageId: page.pageId })
      dispatch('error', { message: null })
      this.render()
    } catch (err) {
      dispatch('error', { message: `Reloading view failed: ${messageFromUnknown(err)}` })
    }
  }

  private onPageChanged(page: PageInfo | null): void {
    this.activePage = page
    if (page !== null) this.screen = 'views'
    this.render()
  }

  private async handleActiveViewDbChange(change: AgentDbChange): Promise<void> {
    if (change.table !== 'views') return
    const page = this.activePage
    const active = activeViewName(page)
    if (!page || !active) return

    if (change.op === 'delete' && (change.rowId === active || change.previousRowId === active)) {
      await this.closeView()
      return
    }

    if (change.op === 'update' && change.previousRowId === active && change.rowId != null && change.rowId !== active) {
      backendSession.renameCurrentViewPage(String(change.rowId))
      return
    }

    if (change.rowId === active) {
      await this.reloadView()
    }
  }

  private async revalidateActivePage(): Promise<void> {
    const page = this.activePage
    const name = activeViewName(page)
    const agentId = backendSession.getActiveAgentId()
    if (!page || !name || !agentId) return
    try {
      const rows = await bridge.mirrorDb.query(
        agentId,
        `SELECT 1 FROM views WHERE name = ? LIMIT 1`,
        [name],
      )
      // The agent or view may have changed during the await; only act if
      // we're still pointed at the same view under the same agent.
      if (activeViewName(this.activePage) !== name) return
      if (backendSession.getActiveAgentId() !== agentId) return
      if (rows.length === 0) {
        await this.closeView()
      } else {
        await this.reloadView()
      }
    } catch {
      // Mirror might not be open yet — leave state alone; the iframe will
      // try to load and show the daemon's own not-found page if necessary.
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  private render() {
    const fullscreen = this.screen !== 'add-agent' && this.hasActiveContent()
    this.shellEl.classList.toggle('is-fullscreen', fullscreen)

    const wantMain = this.screen === 'add-agent' ? 'add-agent' : 'connected'
    if (this.currentMainKind !== wantMain) {
      this.currentMainKind = wantMain
      this.currentBodyKind = null
      this.currentBodyEl = null
      this.bottomTabsEl = null
      this.bodyEl = null
      if (wantMain === 'add-agent') {
        this.mainEl.innerHTML = `<awfy-add-agent-screen></awfy-add-agent-screen>`
        return
      }
      this.mainEl.innerHTML = `
        <awfy-main-header></awfy-main-header>
        <awfy-banner></awfy-banner>
        <div class="body" data-role="body"></div>
      `
      this.bodyEl = this.mainEl.querySelector<HTMLDivElement>('[data-role="body"]')!
    }

    if (wantMain === 'add-agent') return

    this.updateHeader()
    this.updateBody()
    this.updateBottomTabs()
  }

  private hasActiveContent(): boolean {
    if (this.screen === 'chat') return this.activeSessionId !== null || this.draftProviderId !== null
    if (this.screen === 'views') return this.activePage !== null
    return false
  }

  private updateHeader() {
    const header = this.mainEl.querySelector<HTMLElement>('awfy-main-header')
    if (!header) return
    const kind = this.headerKind()
    header.setAttribute('kind', kind)
    if (this.activeSessionId) header.setAttribute('session-id', this.activeSessionId)
    else header.removeAttribute('session-id')
    const viewName = activeViewName(this.activePage)
    if (viewName) header.setAttribute('view-name', viewName)
    else header.removeAttribute('view-name')
    const agentId = backendSession.getActiveAgentId() ?? ''
    header.setAttribute('agent-id', agentId)
  }

  private updateBody() {
    if (!this.bodyEl) return
    const kind = this.pickBodyKind()
    if (this.currentBodyKind !== kind) {
      this.currentBodyKind = kind
      this.bodyEl.innerHTML = `<${BODY_TAG[kind]}></${BODY_TAG[kind]}>`
      this.currentBodyEl = this.bodyEl.firstElementChild as HTMLElement | null
    }
    if (!this.currentBodyEl) return
    if (kind === 'agent-chat' && this.activeSessionId) {
      this.currentBodyEl.setAttribute('session-id', this.activeSessionId)
    }
    if (kind === 'draft-compose' && this.draftProviderId) {
      this.currentBodyEl.setAttribute('provider-id', this.draftProviderId)
    }
    if (kind === 'view-frame' && this.activePage) {
      const viewName = activeViewName(this.activePage)
      if (viewName) this.currentBodyEl.setAttribute('view-name', viewName)
      this.currentBodyEl.setAttribute('page-id', this.activePage.pageId)
      this.currentBodyEl.setAttribute('view-version', String(this.activePage.content?.version ?? 0))
      this.currentBodyEl.setAttribute('view-params', JSON.stringify(activeViewParams(this.activePage)))
    }
  }

  private updateBottomTabs() {
    const inPicker = this.activeSessionId === null
      && this.draftProviderId === null
      && this.activePage === null
    if (inPicker && !this.bottomTabsEl) {
      this.bottomTabsEl = document.createElement('awfy-bottom-tabs')
      this.bottomTabsEl.setAttribute('screen', this.screen)
      this.mainEl.appendChild(this.bottomTabsEl)
    } else if (!inPicker && this.bottomTabsEl) {
      this.bottomTabsEl.remove()
      this.bottomTabsEl = null
    } else if (inPicker && this.bottomTabsEl) {
      this.bottomTabsEl.setAttribute('screen', this.screen)
    }
  }

  private headerKind(): 'picker' | 'session' | 'draft' | 'view' {
    if (this.screen === 'views') return this.activePage ? 'view' : 'picker'
    if (this.activeSessionId) return 'session'
    if (this.draftProviderId !== null) return 'draft'
    return 'picker'
  }

  private pickBodyKind(): BodyKind {
    if (this.screen === 'views') {
      return this.activePage ? 'view-frame' : 'view-list'
    }
    if (this.activeSessionId) return 'agent-chat'
    if (this.draftProviderId !== null) return 'draft-compose'
    return 'session-list'
  }
}

function activeViewName(page: PageInfo | null): string | null {
  return page?.source.type === 'view' ? page.source.name : null
}

function activeViewParams(page: PageInfo): Record<string, string> {
  return page.source.type === 'view' ? page.source.params ?? {} : {}
}
