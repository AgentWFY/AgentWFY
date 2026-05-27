// Mobile renderer entry. Owns the DOM and delegates state to AppController.
//
// Layout shape: persistent two-pane shell with a Discord-style agent rail on
// the left (icons only) and a main pane on the right whose content depends on
// the current screen. Each render function builds the shell HTML and the
// subscribe handler patches sub-regions in place when the screen group / agent
// hasn't changed so the chat composer keeps draft text and focus.

import type { Block, DisplayMessage } from '#shared/agent/provider_types.js'
import type { FileContent, RetryState } from '#shared/agent/types.js'
import type { ProviderState, SessionSummary } from '#shared/backend/interface.js'
import { AppController, type AppState, type InstalledAgent, type Screen, type ViewSummary } from './app-controller.js'

const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  const controller = new AppController()
  bootstrap(controller, app).catch((err) => {
    console.error('[mobile] bootstrap failed:', err)
  })
}

async function bootstrap(controller: AppController, root: HTMLDivElement): Promise<void> {
  installAgentViewBridge(controller)
  installMenuDismissHandler()
  await controller.refreshAgents()
  const agents = controller.getState().agents

  // First-launch UX: jump straight into the add-agent form when nothing's
  // configured. Mirrors desktop "no installed agents -> create a default
  // agent" (main.ts), adapted for remote-only.
  if (agents.length === 0) controller.setScreen('add-agent')

  let lastKey: string | null = null
  controller.subscribe((state) => {
    // Re-render the whole shell whenever the *shape* changes: screen group,
    // active agent, the chat/views sub-tab, OR which "active kind" is showing
    // (session / draft / view / picker). Each kind owns a different header
    // and body so they can't be patched in place.
    const key = `${screenGroup(state.screen)}|${state.activeAgentId ?? ''}|${state.screen}|${activeKind(state)}`
    if (key !== lastKey) {
      lastKey = key
      renderScreen(root, controller, state)
    } else {
      updateRail(root, controller, state)
      updateBanner(root, state)
      updateAgentsBody(root, controller, state)
      updateProviders(root, state)
      updateBottomTabs(root, state)
      renderConnectedBody(root, controller, state)
      updateMainHeader(root, state)
    }
  })
}

function isFullscreen(state: AppState): boolean {
  // Every connected screen (chat or views, picker or active) is fullscreen:
  // the rail only shows on the agents/add-agent surfaces. Navigation between
  // chat/views happens via the bottom tab bar; the header's back button
  // takes the user back to the agents list (or back to the picker when
  // viewing an active session/view).
  return state.screen === 'chat' || state.screen === 'views'
}

function hasActiveContent(state: AppState): boolean {
  if (state.screen === 'chat') {
    return state.activeSession !== null || state.draftProviderId !== null
  }
  if (state.screen === 'views') return state.activeViewName !== null
  return false
}

type ActiveKind = 'session' | 'draft' | 'view' | 'pck'

function activeKind(state: AppState): ActiveKind {
  if (state.screen === 'chat') {
    if (state.activeSession) return 'session'
    if (state.draftProviderId !== null) return 'draft'
    return 'pck'
  }
  if (state.screen === 'views') {
    return state.activeViewName !== null ? 'view' : 'pck'
  }
  return 'pck'
}

type ScreenGroup = 'agents' | 'add-agent' | 'connected'

function screenGroup(screen: Screen): ScreenGroup {
  if (screen === 'agents') return 'agents'
  if (screen === 'add-agent') return 'add-agent'
  return 'connected'
}

function renderScreen(root: HTMLDivElement, controller: AppController, state: AppState): void {
  switch (state.screen) {
    case 'agents':
      renderAgents(root, controller, state)
      return
    case 'add-agent':
      renderAddAgent(root, controller, state)
      return
    case 'chat':
    case 'views':
      renderConnected(root, controller, state)
      return
  }
}

// ── Shell ────────────────────────────────────────────────────────────

function renderShell(
  root: HTMLDivElement,
  mainHtml: string,
  controller: AppController,
  state: AppState,
  options: { fullscreen?: boolean } = {},
): void {
  const fsClass = options.fullscreen ? ' is-fullscreen' : ''
  root.innerHTML = `
    <div class="shell${fsClass}">
      <aside class="rail">
        <div class="rail-brand" aria-hidden="true">A</div>
        <div class="rail-sep"></div>
        <div id="rail-agents" class="rail-agents"></div>
        <div class="rail-sep"></div>
        <button type="button" class="rail-add" id="rail-add" aria-label="Add agent" title="Add agent">
          ${ICON_PLUS}
        </button>
      </aside>
      <main class="main">${mainHtml}</main>
    </div>
  `

  root.querySelector<HTMLButtonElement>('#rail-add')?.addEventListener('click', () => {
    controller.setScreen('add-agent')
  })

  updateRail(root, controller, state)
}

// ── Rail ─────────────────────────────────────────────────────────────

function updateRail(root: HTMLDivElement, controller: AppController, state: AppState): void {

  const railAgents = root.querySelector<HTMLDivElement>('#rail-agents')
  if (!railAgents) return
  if (state.agents.length === 0) {
    railAgents.innerHTML = ''
    return
  }
  railAgents.innerHTML = state.agents.map((a) => renderRailSlot(a, state)).join('')
  railAgents.querySelectorAll<HTMLButtonElement>('[data-action="rail-connect"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const agentId = btn.dataset.agentId
      if (!agentId) return
      const active = state.activeAgentId === agentId
      if (active && (state.screen === 'add-agent')) {
        controller.setScreen('chat')
        return
      }
      if (!active) {
        void controller.connect(agentId)
      } else if (state.screen !== 'chat' && state.screen !== 'views') {
        controller.setScreen('chat')
      }
    })

    // Long-press to remove.
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    const startPress = () => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = setTimeout(() => {
        const agentId = btn.dataset.agentId
        if (!agentId) return
        if (confirm(`Remove agent "${agentId}"?`)) {
          void controller.removeAgent(agentId)
        }
      }, 650)
    }
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer)
        pressTimer = null
      }
    }
    btn.addEventListener('pointerdown', startPress)
    btn.addEventListener('pointerup', cancelPress)
    btn.addEventListener('pointerleave', cancelPress)
    btn.addEventListener('pointercancel', cancelPress)
  })
}

function renderRailSlot(agent: InstalledAgent, state: AppState): string {
  const isActive = state.activeAgentId === agent.agentId
  const onChatOrViews = state.screen === 'chat' || state.screen === 'views'
  const activeClass = isActive && onChatOrViews ? ' is-active' : ''
  const status = isActive ? statusFromState(state) : 'disconnected'
  const initials = getInitials(agent.agentId)
  return `
    <div class="rail-slot${activeClass}" data-status="${status}">
      <span class="rail-indicator"></span>
      <button type="button" class="rail-icon" data-action="rail-connect" data-agent-id="${escapeHtml(agent.agentId)}"
        title="${escapeHtml(agent.agentId)} (${escapeHtml(displayHost(agent.meta.remoteConfig.baseUrl))})"
        aria-label="${escapeHtml(agent.agentId)}">
        ${escapeHtml(initials)}
      </button>
    </div>
  `
}

function statusFromState(state: AppState): string {
  return state.status.state
}

function getInitials(name: string): string {
  const parts = name.split(/[-_\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (name.length >= 2) return name.slice(0, 2).toUpperCase()
  return name.toUpperCase() || '?'
}

// ── Agents (no active agent) ────────────────────────────────────────

function renderAgents(root: HTMLDivElement, controller: AppController, state: AppState): void {

  const hasAgents = state.agents.length > 0
  const mainHtml = `
    <header class="main-header">
      <div class="main-header-title">
        <h1>AgentWFY</h1>
        <span class="main-header-sub">${hasAgents ? 'Pick an agent to connect' : 'Get started'}</span>
      </div>
    </header>
    <div class="banner hidden" id="banner"></div>
    <div class="body" id="body">
      ${hasAgents ? renderAgentsListBody(state) : renderAgentsEmptyBody()}
    </div>
  `

  renderShell(root, mainHtml, controller, state)
  bindAgentsBody(root, controller)
  updateBanner(root, state)
}

function updateAgentsBody(root: HTMLDivElement, controller: AppController, state: AppState): void {
  if (state.screen !== 'agents') return
  const body = root.querySelector<HTMLDivElement>('#body')
  if (!body) return

  const hasAgents = state.agents.length > 0
  body.innerHTML = hasAgents ? renderAgentsListBody(state) : renderAgentsEmptyBody()
  bindAgentsBody(root, controller)

  const subtitle = root.querySelector<HTMLSpanElement>('.main-header-sub')
  if (subtitle) subtitle.textContent = hasAgents ? 'Pick an agent to connect' : 'Get started'
}

function renderAgentsEmptyBody(): string {
  return `
    <div class="empty-state">
      <div class="empty-glyph">${ICON_BOLT}</div>
      <h2>No agents yet</h2>
      <p>Connect to a daemon running <code>agentwfy-server</code>. The desktop app's "Add remote agent" command exposes the bearer token.</p>
      <button type="button" class="btn primary compact" id="empty-add">${ICON_PLUS_SM}<span>Add remote agent</span></button>
    </div>
  `
}

function renderAgentsListBody(state: AppState): string {
  const rows = state.agents.map((a) => `
    <div class="row">
      <button type="button" class="row-main" data-action="connect" data-agent-id="${escapeHtml(a.agentId)}">
        <span class="row-title">${escapeHtml(a.agentId)}</span>
        <span class="row-meta">${escapeHtml(displayHost(a.meta.remoteConfig.baseUrl))}</span>
      </button>
      <button type="button" class="row-action" data-action="remove" data-agent-id="${escapeHtml(a.agentId)}" aria-label="Remove ${escapeHtml(a.agentId)}" title="Remove">
        ${ICON_TRASH}
      </button>
    </div>
  `).join('')
  return `
    <div class="section-header">
      <span class="section-title">Agents</span>
    </div>
    <div class="scroll-list">${rows}</div>
  `
}

function bindAgentsBody(root: HTMLDivElement, controller: AppController): void {
  root.querySelector<HTMLButtonElement>('#empty-add')?.addEventListener('click', () => {
    controller.setScreen('add-agent')
  })
  root.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.agentId
      if (id) void controller.connect(id)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation()
      const id = btn.dataset.agentId
      if (!id) return
      if (!confirm(`Remove agent "${id}"?`)) return
      void controller.removeAgent(id)
    })
  })
}

// ── Add agent form ──────────────────────────────────────────────────

function renderAddAgent(root: HTMLDivElement, controller: AppController, state: AppState): void {

  const cancellable = state.agents.length > 0
  const mainHtml = `
    <header class="main-header">
      <div class="main-header-title">
        <h1>Add remote agent</h1>
        <span class="main-header-sub">Connect to a daemon</span>
      </div>
      <div class="main-header-actions">
        ${cancellable ? `<button type="button" class="icon-btn" id="cancel-x" aria-label="Cancel" title="Cancel">${ICON_X}</button>` : ''}
      </div>
    </header>
    <div class="banner hidden" id="banner"></div>
    <div class="body">
      <div class="form-pane">
        <form class="form" id="add-form" novalidate>
          <div class="field">
            <label class="field-label" for="add-agent-id">Local label</label>
            <input id="add-agent-id" name="agentId" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="my-daemon" required />
            <span class="field-help">Used locally only — anything unique.</span>
          </div>
          <div class="field">
            <label class="field-label" for="add-base-url">Server URL</label>
            <input id="add-base-url" name="baseUrl" autocomplete="off" autocapitalize="none" autocorrect="off" inputmode="url" value="http://127.0.0.1:9878" required />
          </div>
          <div class="field">
            <label class="field-label" for="add-token">Bearer token</label>
            <input id="add-token" name="agentToken" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" required />
          </div>
          <p class="field-error hidden" id="form-error"></p>
          <div class="form-actions">
            <button type="submit" class="btn primary">${ICON_PLUG}<span>Connect</span></button>
            ${cancellable ? `<button type="button" class="btn ghost" id="cancel">Cancel</button>` : ''}
          </div>
        </form>
      </div>
    </div>
  `

  renderShell(root, mainHtml, controller, state)

  const form = root.querySelector<HTMLFormElement>('#add-form')!
  const errorEl = root.querySelector<HTMLParagraphElement>('#form-error')!
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    if (submitBtn.disabled) return
    submitBtn.disabled = true
    errorEl.classList.add('hidden')
    const data = new FormData(form)
    let agentId: string
    try {
      agentId = await controller.addRemoteAgent({
        agentId: String(data.get('agentId') ?? ''),
        baseUrl: String(data.get('baseUrl') ?? ''),
        agentToken: String(data.get('agentToken') ?? ''),
      })
    } catch (err) {
      submitBtn.disabled = false
      errorEl.classList.remove('hidden')
      errorEl.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    controller.setScreen('agents')
    void controller.connect(agentId)
  })

  const cancel = () => controller.setScreen(state.activeAgentId ? 'chat' : 'agents')
  root.querySelector<HTMLButtonElement>('#cancel')?.addEventListener('click', cancel)
  root.querySelector<HTMLButtonElement>('#cancel-x')?.addEventListener('click', cancel)

  updateBanner(root, state)
}

// ── Connected ────────────────────────────────────────────────────────
//
// Two visual modes, picked at every full re-render from isFullscreen(state):
//   • picker:    rail visible + dark header (agent name) + bottom tabs.
//                Body is the sessions list or views list.
//   • fullscreen: rail hidden + dark header with back button. Body is the
//                 active chat (messages + composer) or the iframe.

let bodyMode: 'picker' | 'active' = 'picker'

function renderConnected(root: HTMLDivElement, controller: AppController, state: AppState): void {
  const agentId = state.activeAgentId
  const meta = state.activeMeta
  if (!agentId || !meta) {
    controller.setScreen('agents')
    return
  }

  const fullscreen = isFullscreen(state)
  const active = hasActiveContent(state)
  bodyMode = state.activeSession || state.draftProviderId !== null ? 'active' : 'picker'

  const mainHtml = active
    ? buildActiveContentMainHtml(state)
    : buildPickerMainHtml(state, agentId)

  renderShell(root, mainHtml, controller, state, { fullscreen })

  if (active) {
    bindActiveContentHandlers(root, controller, state)
  } else {
    bindPickerHandlers(root, controller, state, agentId)
  }

  updateBottomTabs(root, state)
  updateProviders(root, state)
  renderConnectedBody(root, controller, state)
  updateBanner(root, state)
}

function buildPickerMainHtml(state: AppState, agentId: string): string {
  return `
    <header class="main-header">
      <button type="button" class="icon-btn back-btn" id="back-to-agents" aria-label="Agents" title="Agents">${ICON_BACK}</button>
      <div class="main-header-title">
        <h1 id="header-title">${escapeHtml(agentId)}</h1>
      </div>
      <div class="main-header-actions">
        <span class="status-dot" id="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
        <button type="button" class="icon-btn" id="header-menu" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
        <div class="menu hidden" id="header-menu-list">
          <button type="button" class="menu-item" id="menu-disconnect">${ICON_PLUG}<span>Disconnect</span></button>
          <button type="button" class="menu-item danger" id="menu-remove">${ICON_TRASH}<span>Remove agent</span></button>
        </div>
      </div>
    </header>
    <div class="banner hidden" id="banner"></div>
    <div id="providers-panel"></div>
    <div class="body" id="connected-body"></div>
    <nav class="bottom-tabs" id="bottom-tabs">
      <button type="button" class="bottom-tab-btn" data-screen="chat">${ICON_CHAT}<span>Chat</span></button>
      <button type="button" class="bottom-tab-btn" data-screen="views">${ICON_GRID}<span>Views</span></button>
    </nav>
  `
}

function buildActiveContentMainHtml(state: AppState): string {
  if (state.activeSession) {
    const title = state.activeSession.title || 'Chat'
    return `
      <header class="main-header">
        <button type="button" class="icon-btn back-btn" id="back-btn" aria-label="Back" title="Back">${ICON_BACK}</button>
        <div class="main-header-title">
          <h1 id="header-title">${escapeHtml(title)}</h1>
        </div>
        <div class="main-header-actions">
          <span class="status-dot" id="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
          <button type="button" class="icon-btn" id="header-menu" aria-label="Menu" title="Menu">${ICON_KEBAB}</button>
          <div class="menu hidden" id="header-menu-list">
            <button type="button" class="menu-item danger" id="menu-remove-session">${ICON_TRASH}<span>Remove session</span></button>
          </div>
        </div>
      </header>
      <div class="banner hidden" id="banner"></div>
      <div class="body" id="connected-body"></div>
    `
  }
  if (state.draftProviderId !== null) {
    return `
      <header class="main-header">
        <button type="button" class="icon-btn back-btn" id="back-btn" aria-label="Cancel" title="Cancel">${ICON_BACK}</button>
        <div class="main-header-title">
          <h1 id="header-title">New session</h1>
        </div>
        <div class="main-header-actions">
          <span class="status-dot" id="status-dot" data-state="${state.status.state}" title="${escapeHtml(formatStatus(state))}"></span>
        </div>
      </header>
      <div class="banner hidden" id="banner"></div>
      <div class="body" id="connected-body"></div>
    `
  }
  const view = state.views.find((v) => v.name === state.activeViewName)
  const title = view?.title || state.activeViewName || 'View'
  return `
    <header class="main-header">
      <button type="button" class="icon-btn back-btn" id="back-btn" aria-label="Back" title="Back">${ICON_BACK}</button>
      <div class="main-header-title">
        <h1 id="header-title">${escapeHtml(title)}</h1>
      </div>
      <div class="main-header-actions">
        <button type="button" class="icon-btn" id="view-reload" aria-label="Reload" title="Reload">${ICON_REFRESH}</button>
      </div>
    </header>
    <div class="body" id="connected-body"></div>
  `
}

function bindPickerHandlers(
  root: HTMLDivElement,
  controller: AppController,
  state: AppState,
  agentId: string,
): void {
  root.querySelector<HTMLButtonElement>('#back-to-agents')?.addEventListener('click', () => {
    // Stack-style back: leave the connected pair (chat/views) and surface
    // the agents list so the rail re-appears and the user can switch agents.
    // We don't disconnect — the active session keeps streaming and the user
    // can re-enter by tapping the same agent.
    controller.setScreen('agents')
  })

  root.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.screen as Screen | undefined
      if (t === 'chat' || t === 'views') controller.setScreen(t)
    })
  })

  const menuBtn = root.querySelector<HTMLButtonElement>('#header-menu')
  const menuList = root.querySelector<HTMLDivElement>('#header-menu-list')
  if (menuBtn && menuList) {
    menuBtn.addEventListener('click', (evt) => {
      evt.stopPropagation()
      menuList.classList.toggle('hidden')
    })
  }
  root.querySelector<HTMLButtonElement>('#menu-disconnect')?.addEventListener('click', async () => {
    menuList?.classList.add('hidden')
    await controller.disconnect()
    controller.setScreen('agents')
  })
  root.querySelector<HTMLButtonElement>('#menu-remove')?.addEventListener('click', async () => {
    menuList?.classList.add('hidden')
    if (!confirm(`Remove agent "${agentId}"?`)) return
    await controller.removeAgent(agentId)
    controller.setScreen('agents')
  })
  void state
}

function bindActiveContentHandlers(
  root: HTMLDivElement,
  controller: AppController,
  state: AppState,
): void {
  root.querySelector<HTMLButtonElement>('#back-btn')?.addEventListener('click', () => {
    if (state.activeSession) controller.closeSession()
    else if (state.draftProviderId !== null) controller.cancelDraft()
    else if (state.activeViewName) controller.closeView()
  })

  root.querySelector<HTMLButtonElement>('#view-reload')?.addEventListener('click', () => {
    controller.reloadView()
  })

  const menuBtn = root.querySelector<HTMLButtonElement>('#header-menu')
  const menuList = root.querySelector<HTMLDivElement>('#header-menu-list')
  if (menuBtn && menuList) {
    menuBtn.addEventListener('click', (evt) => {
      evt.stopPropagation()
      menuList.classList.toggle('hidden')
    })
  }
  root.querySelector<HTMLButtonElement>('#menu-remove-session')?.addEventListener('click', () => {
    menuList?.classList.add('hidden')
    const current = controller.getState().activeSession
    if (!current) return
    const label = current.title || 'Untitled session'
    if (!confirm(`Remove session "${label}"?`)) return
    void controller.removeSession(current.sessionId)
  })
}

function updateMainHeader(root: HTMLDivElement, state: AppState): void {
  const title = root.querySelector<HTMLHeadingElement>('#header-title')
  const dot = root.querySelector<HTMLSpanElement>('#status-dot')
  if (title) {
    if (state.activeSession) {
      title.textContent = state.activeSession.title || 'Chat'
    } else if (state.draftProviderId !== null) {
      title.textContent = 'New session'
    } else if (state.activeViewName) {
      const view = state.views.find((v) => v.name === state.activeViewName)
      title.textContent = view?.title || state.activeViewName
    } else if (state.activeAgentId) {
      title.textContent = state.activeAgentId
    }
  }
  if (dot) {
    dot.dataset.state = state.status.state
    dot.title = formatStatus(state)
  }
}

function updateBottomTabs(root: HTMLElement, state: AppState): void {
  const nav = root.querySelector<HTMLElement>('#bottom-tabs')
  if (!nav) return
  nav.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
    const t = btn.dataset.screen
    const active = t === state.screen
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-current', active ? 'page' : 'false')
  })
}

function updateProviders(root: HTMLDivElement, state: AppState): void {
  const panel = root.querySelector<HTMLDivElement>('#providers-panel')
  if (!panel) return
  if (state.activeAgentId === null) {
    panel.innerHTML = ''
    return
  }
  panel.innerHTML = renderProvidersHtml(state.providers, state.screen)
}

function renderProvidersHtml(providers: ProviderState | null, screen: Screen): string {
  // Only used to surface the empty-providers warning on the session list;
  // when providers exist, "New session" auto-picks the default.
  if (screen !== 'chat') return ''
  if (!providers) return ''
  if (providers.providerList.length === 0) {
    return `
      <div class="banner" data-tone="error" style="margin-top: 10px">
        No providers configured on this daemon. Configure one in the daemon's settings before starting a session.
      </div>
    `
  }
  return ''
}

function renderConnectedBody(root: HTMLDivElement, controller: AppController, state: AppState): void {
  const body = root.querySelector<HTMLDivElement>('#connected-body')
  if (!body) return

  if (state.screen === 'views') {
    renderViewsBody(body, controller, state)
    return
  }
  if (state.activeSession) {
    renderActiveSessionBody(body, controller, state)
    return
  }
  if (state.draftProviderId !== null) {
    renderDraftBody(body, controller, state)
    return
  }
  renderPickerBody(body, controller, state)
}

// ── Views body ──────────────────────────────────────────────────────

let cachedViewFrame: HTMLIFrameElement | null = null
let cachedViewFrameName: string | null = null
let cachedViewFrameVersion: number | null = null

function renderViewsBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  bodyMode = 'picker'
  delete body.dataset.providerKey
  delete body.dataset.sessionId

  const activeName = state.activeViewName
  const wantMode = activeName ? 'view-frame' : 'view-list'
  if (body.dataset.mode !== wantMode) {
    body.dataset.mode = wantMode
    if (wantMode === 'view-list') {
      body.innerHTML = `<div class="scroll-list" id="view-list"></div>`
    } else {
      body.innerHTML = `<div class="view-frame-wrap" id="view-frame-wrap"></div>`
    }
  }

  if (wantMode === 'view-list') {
    const list = body.querySelector<HTMLDivElement>('#view-list')
    if (list) list.innerHTML = renderViewRowsHtml(state.views)
    bindViewRowHandlers(body, controller)
    return
  }

  if (!activeName) return
  const wrap = body.querySelector<HTMLDivElement>('#view-frame-wrap')
  if (!wrap) return

  if (!cachedViewFrame) {
    cachedViewFrame = document.createElement('iframe')
    cachedViewFrame.className = 'view-frame'
    cachedViewFrame.setAttribute('title', 'Agent view')
    cachedViewFrame.setAttribute('referrerpolicy', 'no-referrer')
  }
  if (cachedViewFrame.parentElement !== wrap) {
    wrap.replaceChildren(cachedViewFrame)
  }
  if (cachedViewFrameName !== activeName || cachedViewFrameVersion !== state.viewVersion) {
    cachedViewFrame.setAttribute('src', buildViewSrc(activeName, state.viewVersion))
    cachedViewFrameName = activeName
    cachedViewFrameVersion = state.viewVersion
  }
}

function buildViewSrc(name: string, version: number): string {
  return `agentview://localhost/view/${encodeURIComponent(name)}?tabId=mobile-view&rev=${version}`
}

function renderViewRowsHtml(views: ViewSummary[]): string {
  if (views.length === 0) {
    return `<div class="empty-list">No views yet. Ask the agent to create one.</div>`
  }
  return views.map(renderViewRow).join('')
}

function renderViewRow(v: ViewSummary): string {
  const title = v.title || v.name
  const subtitle = v.title ? v.name : ''
  return `
    <div class="row">
      <button type="button" class="row-main" data-action="open-view" data-view-name="${escapeHtml(v.name)}">
        <span class="row-title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="row-meta">${escapeHtml(subtitle)}</span>` : ''}
      </button>
    </div>
  `
}

function bindViewRowHandlers(body: HTMLDivElement, controller: AppController): void {
  body.querySelectorAll<HTMLButtonElement>('[data-action="open-view"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.viewName
      if (name) controller.openView(name)
    })
  })
}

// ── Session picker ──────────────────────────────────────────────────

function renderPickerBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  if (bodyMode !== 'picker' || body.dataset.mode !== 'picker') {
    bodyMode = 'picker'
    body.dataset.mode = 'picker'
    delete body.dataset.providerKey
    delete body.dataset.sessionId
    body.innerHTML = `
      <div class="scroll-list" id="session-list"></div>
      <div class="picker-actions">
        <button type="button" class="btn primary" id="new-session-btn">
          ${ICON_PLUS_SM}<span>New session</span>
        </button>
      </div>
    `
  }

  const list = body.querySelector<HTMLDivElement>('#session-list')
  if (list) list.innerHTML = renderSessionRowsHtml(state.sessions)
  bindSessionRowHandlers(body, controller, state.sessions)

  const newBtn = body.querySelector<HTMLButtonElement>('#new-session-btn')
  if (newBtn) {
    const reason = newSessionDisabledReason(state)
    newBtn.disabled = reason !== null
    newBtn.title = reason ?? 'Start a new session'
    newBtn.onclick = () => {
      if (newBtn.disabled) return
      const providerId = defaultDraftProviderId(state.providers)
      if (providerId) controller.startDraft(providerId)
    }
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

function renderSessionRowsHtml(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return `<div class="empty-list">No sessions yet. Send a message to start one.</div>`
  }
  return sessions.map(renderSessionRow).join('')
}

function renderSessionRow(s: SessionSummary): string {
  const title = s.title || 'Untitled session'
  return `
    <div class="row">
      <button type="button" class="row-main" data-action="open" data-session-id="${escapeHtml(s.sessionId)}">
        <span class="row-title">${escapeHtml(title)}</span>
        <span class="row-meta">${escapeHtml(s.providerId || '—')} · ${escapeHtml(formatRelative(s.updatedAt))}</span>
      </button>
      <button type="button" class="row-action" data-action="remove-session" data-session-id="${escapeHtml(s.sessionId)}" aria-label="Remove session" title="Remove">
        ${ICON_TRASH}
      </button>
    </div>
  `
}

function bindSessionRowHandlers(
  body: HTMLDivElement,
  controller: AppController,
  sessions: SessionSummary[],
): void {
  body.querySelectorAll<HTMLButtonElement>('[data-action="open"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void controller.loadSession(btn.dataset.sessionId!)
    })
  })
  body.querySelectorAll<HTMLButtonElement>('[data-action="remove-session"]').forEach((btn) => {
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

// ── Active session ──────────────────────────────────────────────────

function renderActiveSessionBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  const session = state.activeSession!
  if (bodyMode !== 'active' || body.dataset.mode !== 'active' || body.dataset.sessionId !== session.sessionId) {
    bodyMode = 'active'
    body.dataset.mode = 'active'
    body.dataset.sessionId = session.sessionId
    body.innerHTML = `
      <div class="message-list" id="message-list"></div>
      ${renderComposerHtml(state, 'followup')}
      <div class="composer-status" id="composer-status"></div>
    `
    bindComposer(body, controller)
  }

  updateMessages(body.querySelector<HTMLDivElement>('#message-list')!, state)
  applyLiveStatus(body.querySelector<HTMLDivElement>('#composer-status')!, state)
  updateComposerState(body, state)
}

// ── Draft session ───────────────────────────────────────────────────
//
// Compose surface shown after the user tapped "New session" but before
// they've sent the first message. Mirrors the desktop chat panel's
// new-session view: a grid of provider cards (default pre-selected) and
// the composer with a status line below it. Tapping a card swaps
// draftProviderId; the first sendMessage() spawns the session under it.

function renderDraftBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  if (bodyMode !== 'active' || body.dataset.mode !== 'draft') {
    bodyMode = 'active'
    body.dataset.mode = 'draft'
    delete body.dataset.sessionId
    delete body.dataset.providerKey
    delete body.dataset.subMode
    body.innerHTML = `
      <div class="provider-grid" id="provider-grid"></div>
      ${renderComposerHtml(state, 'draft')}
      <div class="composer-status" id="composer-status"></div>
    `
    bindComposer(body, controller)
  }

  const grid = body.querySelector<HTMLDivElement>('#provider-grid')!
  renderProviderGrid(grid, controller, state)
  applyLiveStatus(body.querySelector<HTMLDivElement>('#composer-status')!, state)
  updateComposerState(body, state)
}

function renderProviderGrid(host: HTMLDivElement, controller: AppController, state: AppState): void {
  const providers = state.providers
  if (!providers || providers.providerList.length === 0) {
    host.innerHTML = `<div class="empty-list">No providers configured.</div>`
    return
  }
  const selectedId = state.draftProviderId
  const statusLines = new Map(providers.providerStatusLines)
  host.innerHTML = providers.providerList.map((p) => {
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

  host.querySelectorAll<HTMLButtonElement>('.provider-card[data-provider-id]').forEach((card) => {
    card.onclick = () => {
      const id = card.dataset.providerId
      if (!id || id === selectedId) return
      controller.startDraft(id)
    }
  })
}

function applyLiveStatus(el: HTMLElement, state: AppState): void {
  const live = state.activeSession?.live
  if (state.status.state !== 'connected') {
    el.dataset.tone = 'error'
    el.textContent = state.status.message || 'Disconnected'
    return
  }
  if (live?.retryState) {
    el.dataset.tone = 'warn'
    el.textContent = formatRetry(live.retryState)
    return
  }
  if (live?.stalledSince) {
    el.dataset.tone = 'warn'
    el.textContent = `No response for ${formatDuration(Date.now() - live.stalledSince)}.`
    return
  }
  delete el.dataset.tone
  if (live?.statusLine) {
    el.textContent = live.statusLine
    return
  }
  if (live?.isStreaming) {
    el.textContent = 'Streaming response…'
    return
  }
  // Draft: surface the selected provider's status line so the user knows
  // what they're about to spawn under.
  if (!state.activeSession && state.draftProviderId !== null) {
    const lines = new Map(state.providers?.providerStatusLines ?? [])
    el.textContent = lines.get(state.draftProviderId) || ''
    return
  }
  el.textContent = 'Ready'
}

// ── Composer ────────────────────────────────────────────────────────

type ComposerMode = 'draft' | 'followup'

function renderComposerHtml(_state: AppState, mode: ComposerMode): string {
  const placeholder = mode === 'draft' ? 'Ask the agent anything…' : 'Send a follow-up…'
  return `
    <form class="composer chat-composer" data-mode="${mode}" novalidate>
      <div class="composer-field">
        <textarea name="prompt" rows="1" autocapitalize="sentences" required placeholder="${placeholder}"></textarea>
        <button type="submit" class="composer-send" aria-label="Send" title="Send">${ICON_SEND}</button>
      </div>
      <div class="composer-meta">
        <span class="composer-hint" hidden></span>
        <button type="button" class="composer-abort" hidden>Abort</button>
      </div>
      <p class="field-error composer-error hidden"></p>
    </form>
  `
}

function bindComposer(scope: HTMLElement, controller: AppController): void {
  const form = scope.querySelector<HTMLFormElement>('.chat-composer')
  if (!form) return
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!
  const errorEl = form.querySelector<HTMLParagraphElement>('.composer-error')!
  const submitBtn = form.querySelector<HTMLButtonElement>('.composer-send')!
  const abortBtn = form.querySelector<HTMLButtonElement>('.composer-abort')!

  textarea.addEventListener('input', () => {
    autoSizeTextarea(textarea)
    errorEl.classList.add('hidden')
  })

  form.addEventListener('submit', (evt) => {
    evt.preventDefault()
    if (submitBtn.disabled) return
    const prompt = textarea.value.trim()
    if (!prompt) {
      errorEl.classList.remove('hidden')
      errorEl.textContent = 'Prompt is required.'
      textarea.focus()
      return
    }
    const data = new FormData(form)
    const providerId = data.get('providerId')
    form.dataset.sending = 'true'
    submitBtn.disabled = true
    errorEl.classList.add('hidden')
    textarea.value = ''
    autoSizeTextarea(textarea)
    void controller.sendMessage({
      text: prompt,
      providerId: providerId ? String(providerId) : undefined,
    }).then((sessionId) => {
      if (!sessionId && document.contains(form)) {
        textarea.value = prompt
        autoSizeTextarea(textarea)
      }
    }).finally(() => {
      delete form.dataset.sending
      if (document.contains(form)) updateComposerState(scope, controller.getState())
    })
  })

  abortBtn.addEventListener('click', () => {
    if (abortBtn.disabled) return
    abortBtn.disabled = true
    void controller.abortActiveSession().finally(() => {
      if (document.contains(abortBtn)) abortBtn.disabled = false
    })
  })

  autoSizeTextarea(textarea)
}

function updateComposerState(scope: HTMLElement, state: AppState): void {
  const form = scope.querySelector<HTMLFormElement>('.chat-composer')
  if (!form) return
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')
  const select = form.querySelector<HTMLSelectElement>('select[name="providerId"]')
  const submitBtn = form.querySelector<HTMLButtonElement>('.composer-send')
  const abortBtn = form.querySelector<HTMLButtonElement>('.composer-abort')
  const hint = form.querySelector<HTMLSpanElement>('.composer-hint')
  const reason = composerDisabledReason(state)
  const canSend = reason === null
  const sending = form.dataset.sending === 'true'
  if (textarea) textarea.disabled = !canSend
  if (select) select.disabled = !canSend
  if (submitBtn) submitBtn.disabled = !canSend || sending
  if (hint) {
    hint.hidden = reason === null
    hint.textContent = reason ?? ''
  }
  if (abortBtn) {
    const abortable = canAbort(state)
    abortBtn.hidden = !hasLiveWork(state)
    abortBtn.disabled = !abortable
  }
}

function composerDisabledReason(state: AppState): string | null {
  if (state.status.state !== 'connected') {
    return state.status.message || 'Remote agent is disconnected.'
  }
  if (!state.activeSession && !state.providers) return 'Loading providers…'
  if (!state.activeSession && state.providers?.providerList.length === 0) {
    return 'No providers are configured on this daemon.'
  }
  return null
}

function hasLiveWork(state: AppState): boolean {
  const live = state.activeSession?.live
  return !!(live?.isStreaming || live?.retryState)
}

function canAbort(state: AppState): boolean {
  return state.status.state === 'connected' && !!state.activeSession && hasLiveWork(state)
}

// ── Messages ────────────────────────────────────────────────────────

function updateMessages(container: HTMLDivElement, state: AppState): void {
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120
  container.innerHTML = renderMessagesHtml(getDisplayMessagesForRender(state))
  if (wasNearBottom || state.activeSession?.live?.isStreaming) {
    container.scrollTop = container.scrollHeight
  }
}

function getDisplayMessagesForRender(state: AppState): DisplayMessage[] {
  const session = state.activeSession
  if (!session) return []
  const messages = [...session.messages]
  const streaming = session.live?.streamingMessage
  if (streaming) messages.push(streaming)
  return messages
}

function renderMessagesHtml(messages: DisplayMessage[]): string {
  if (messages.length === 0) {
    return `<div class="empty-chat">No messages yet.</div>`
  }
  return messages.map((message) => renderMessageHtml(message)).join('')
}

function renderMessageHtml(message: DisplayMessage): string {
  const roleLabel = message.role === 'user' ? 'You' : 'Agent'
  return `
    <article class="chat-message" data-role="${message.role}">
      <div class="message-role">${roleLabel}</div>
      <div class="message-body">${message.blocks.map(renderBlockHtml).join('')}</div>
    </article>
  `
}

function renderBlockHtml(block: Block): string {
  switch (block.type) {
    case 'text':
      return `<div class="message-text">${escapeHtml(block.text)}</div>`
    case 'thinking':
      return `<details class="thinking-block"><summary>Thinking</summary><div class="message-text">${escapeHtml(block.text)}</div></details>`
    case 'file':
      return renderFileHtml({ type: 'file', data: block.data, mimeType: block.mimeType })
    case 'attachment':
      return `<div class="file-chip">${escapeHtml(block.label)} · ${formatBytes(block.size)}</div>`
    case 'exec_js':
      return `
        <details class="tool-card">
          <summary>${escapeHtml(block.description || 'Running JavaScript')}</summary>
          <pre>${escapeHtml(block.code)}</pre>
        </details>
      `
    case 'exec_js_result':
      return `
        <details class="tool-card ${block.isError ? 'is-error' : ''}">
          <summary>${block.isError ? 'JavaScript error' : 'JavaScript result'}</summary>
          <div class="tool-result">${block.content.map(renderToolContentHtml).join('')}</div>
        </details>
      `
    case 'error':
      return `<div class="message-error">${escapeHtml(block.text)}</div>`
  }
}

function renderToolContentHtml(content: FileContent | { type: 'text'; text: string }): string {
  if (content.type === 'file') return renderFileHtml(content)
  return `<pre>${escapeHtml(content.text)}</pre>`
}

function renderFileHtml(file: FileContent): string {
  if (file.mimeType.startsWith('image/')) {
    return `<img class="message-image" src="data:${escapeHtml(file.mimeType)};base64,${escapeHtml(file.data)}" alt="attachment">`
  }
  return `<div class="file-chip">${escapeHtml(file.mimeType)}</div>`
}

function formatRetry(retry: RetryState): string {
  const delay = Math.max(0, retry.nextRetryAt - Date.now())
  return `Retrying in ${formatDuration(delay)} (attempt ${retry.attempt}/${retry.maxAttempts}): ${retry.lastError}`
}

function formatDuration(ms: number): string {
  const sec = Math.ceil(Math.max(0, ms) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'unknown size'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function autoSizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(140, Math.max(36, textarea.scrollHeight))}px`
}

function formatRelative(ts: number): string {
  if (!ts) return 'unknown'
  const delta = Date.now() - ts
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

// ── Banner / status ─────────────────────────────────────────────────

function updateBanner(root: HTMLDivElement, state: AppState): void {
  const banner = root.querySelector<HTMLDivElement>('#banner')
  if (banner) {
    const message = bannerMessage(state)
    if (message) {
      banner.classList.remove('hidden')
      banner.textContent = message
      banner.dataset.tone = bannerTone(state)
    } else {
      banner.classList.add('hidden')
      banner.textContent = ''
    }
  }
}

function bannerMessage(state: AppState): string | null {
  if (state.error) return state.error
  if (state.status.state === 'error') return state.status.message || 'Connection error.'
  return null
}

function bannerTone(state: AppState): string {
  return state.status.state === 'error' || state.error ? 'error' : 'info'
}

function formatStatus(state: AppState): string {
  if (state.status.state === 'disconnected' && !state.activeAgentId) return 'Idle'
  const base = `${capitalize(state.status.state)}${state.status.message ? ` — ${state.status.message}` : ''}`
  if (state.lastSyncAt !== null) return `${base} · synced`
  return base
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return ch
    }
  })
}

// Close kebab menu on outside click / touch.
function installMenuDismissHandler(): void {
  const dismiss = (evt: Event) => {
    const target = evt.target as HTMLElement | null
    if (!target) return
    if (target.closest('#header-menu') || target.closest('#header-menu-list')) return
    document.querySelectorAll<HTMLDivElement>('.menu').forEach((m) => m.classList.add('hidden'))
  }
  document.addEventListener('click', dismiss)
  document.addEventListener('touchstart', dismiss, { passive: true })
}

// ── Icons (inline SVG) ──────────────────────────────────────────────

const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
const ICON_PLUS_SM = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`
const ICON_KEBAB = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`
const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
const ICON_REFRESH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14"/></svg>`
const ICON_CHAT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`
const ICON_GRID = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`
const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`
const ICON_PLUG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 1 1-12 0V8z"/><path d="M12 18v4"/></svg>`
const ICON_BOLT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`

// ── Agent view bridge ───────────────────────────────────────────────
//
// Mobile's `agentview://` frames cannot use Electron's preload/contextBridge.
// The Rust URI handler injects a tiny script that posts calls here; this
// parent-side handler mirrors desktop/ipc/runtime-functions.ts by routing
// through the active backend's FunctionsApi.

const AGENT_VIEW_CALL_CHANNEL = 'agentwfy:view-call'
const AGENT_VIEW_RESULT_CHANNEL = 'agentwfy:view-result'

interface AgentViewCallMessage {
  channel: typeof AGENT_VIEW_CALL_CHANNEL
  id: string
  name: string
  params: unknown
}

interface AgentViewErrorPayload {
  name: string
  message: string
}

function installAgentViewBridge(controller: AppController): void {
  window.addEventListener('message', (event) => {
    const message = parseAgentViewCall(event.data)
    if (!message) return

    const frame = findAgentViewFrameForSource(event.source)
    if (!frame || !isAllowedAgentViewOrigin(event.origin)) {
      console.warn('[mobile-view] rejected message from untrusted source:', event.origin)
      return
    }

    void handleAgentViewCall(controller, frame, event.origin, message)
  })
}

async function handleAgentViewCall(
  controller: AppController,
  frame: HTMLIFrameElement,
  origin: string,
  message: AgentViewCallMessage,
): Promise<void> {
  try {
    const backend = controller.getBackend()
    if (!backend) {
      throw new Error('Remote agent is not connected.')
    }

    const available = new Set(backend.functions.getNamesSync())
    if (!available.has(message.name)) {
      throw new Error(`Unknown function: ${message.name}`)
    }

    const value = await backend.functions.invoke({
      name: message.name,
      params: message.params,
    })
    postAgentViewResult(frame, origin, message.id, { ok: true, value })
  } catch (err) {
    postAgentViewResult(frame, origin, message.id, {
      ok: false,
      error: normalizeAgentViewError(err),
    })
  }
}

function parseAgentViewCall(data: unknown): AgentViewCallMessage | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Partial<AgentViewCallMessage>
  if (raw.channel !== AGENT_VIEW_CALL_CHANNEL) return null
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) return null
  return {
    channel: AGENT_VIEW_CALL_CHANNEL,
    id: raw.id,
    name: raw.name.trim(),
    params: raw.params,
  }
}

function findAgentViewFrameForSource(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe')) {
    if (frame.contentWindow === source && isAgentViewFrame(frame)) {
      return frame
    }
  }
  return null
}

function isAgentViewFrame(frame: HTMLIFrameElement): boolean {
  const src = frame.getAttribute('src') || frame.src
  try {
    const url = new URL(src, window.location.href)
    return url.protocol === 'agentview:' && url.hostname === 'localhost'
  } catch {
    return src.startsWith('agentview://localhost/')
  }
}

function isAllowedAgentViewOrigin(origin: string): boolean {
  // WebKit may report custom schemes as an opaque origin. The iframe source
  // check above is the primary trust boundary in that case.
  return origin === 'agentview://localhost' || origin === 'null'
}

function postAgentViewResult(
  frame: HTMLIFrameElement,
  origin: string,
  id: string,
  result: { ok: true; value: unknown } | { ok: false; error: AgentViewErrorPayload },
): void {
  const target = frame.contentWindow
  if (!target) return
  target.postMessage({
    channel: AGENT_VIEW_RESULT_CHANNEL,
    id,
    ...result,
  }, origin === 'null' ? '*' : origin)
}

function normalizeAgentViewError(err: unknown): AgentViewErrorPayload {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: err.message || 'Unknown error' }
  }
  return { name: 'Error', message: String(err) }
}
