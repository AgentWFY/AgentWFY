// Mobile renderer entry. Owns the DOM and delegates state to AppController.
//
// The renderer is intentionally not a web-component framework — it's a
// per-screen render function picked off the current AppState. Each render
// fn wires its own listeners against the controller; the subscribe handler
// re-renders only when the screen or active agent changes, so in-flight
// form input survives background state patches (status, lastSyncAt, etc.).
//
// Two screens map directly to desktop's flow: the agents list (== desktop
// sidebar) and the add-agent form (== command-palette add-remote-agent).

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
  await controller.refreshAgents()
  const agents = controller.getState().agents

  // First-launch UX: jump straight into the add-agent form when nothing's
  // configured. Mirrors desktop "no installed agents -> create a default
  // agent" (main.ts), adapted for remote-only.
  if (agents.length === 0) controller.setScreen('add-agent')

  let lastScreenGroup: ScreenGroup | null = null
  let lastActiveAgentId: string | null | undefined
  controller.subscribe((state) => {
    // Re-render the whole screen on screen-GROUP / active-agent transitions.
    // 'chat' and 'views' share a group so a chat→views switch keeps the
    // cached view iframe attached (preserving its WKWebView state) and
    // just swaps the body sub-tree.
    const group = screenGroup(state.screen)
    if (group !== lastScreenGroup || state.activeAgentId !== lastActiveAgentId) {
      lastScreenGroup = group
      lastActiveAgentId = state.activeAgentId
      renderScreen(root, controller, state)
    } else {
      updateBanner(root, state)
      updateAgentsList(root, controller, state)
      renderConnectedBody(root, controller, state)
      updateProviders(root, state)
      updateConnectedTabs(root, state)
    }
  })
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

// ── Agents list ─────────────────────────────────────────────────────

function renderAgents(root: HTMLDivElement, controller: AppController, state: AppState): void {
  root.innerHTML = `
    <section class="shell">
      <header class="brand">
        <span class="mark">A</span>
        <div>
          <h1>AgentWFY</h1>
          <p>Pick an agent to connect to.</p>
        </div>
      </header>
      <div class="agent-list" id="agent-list"></div>
      <div class="banner" id="banner" hidden></div>
      <button type="button" class="primary" id="add-agent">Add remote agent</button>
    </section>
  `

  root.querySelector<HTMLButtonElement>('#add-agent')!.addEventListener('click', () => {
    controller.setScreen('add-agent')
  })

  updateAgentsList(root, controller, state)
  updateBanner(root, state)
}

// Rewrites #agent-list innerHTML AND re-binds row handlers. Called from
// renderAgents on full re-render and from the subscribe-fallthrough path
// when state.agents changes without a screen transition (e.g. after
// removing a non-active agent). Skipping the rebind would leave the new
// rows tap-dead.
function updateAgentsList(root: HTMLDivElement, controller: AppController, state: AppState): void {
  const list = root.querySelector<HTMLDivElement>('#agent-list')
  if (!list) return
  if (state.agents.length === 0) {
    list.innerHTML = `<p class="muted">No agents added yet.</p>`
    return
  }
  list.innerHTML = state.agents.map(renderAgentRow).join('')
  list.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void controller.connect(btn.dataset.agentId!)
    })
  })
  list.querySelectorAll<HTMLButtonElement>('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation()
      const agentId = btn.dataset.agentId!
      const target = state.agents.find((a) => a.agentId === agentId)
      if (!target) return
      if (!confirm(`Remove agent "${target.agentId}"?`)) return
      void controller.removeAgent(agentId)
    })
  })
}

function renderAgentRow(a: InstalledAgent): string {
  return `
    <div class="agent-row">
      <button type="button" class="agent-row-main" data-action="connect" data-agent-id="${escapeHtml(a.agentId)}">
        <span class="agent-label">${escapeHtml(a.agentId)}</span>
        <span class="agent-meta">${escapeHtml(displayHost(a.meta.remoteConfig.baseUrl))}</span>
      </button>
      <button type="button" class="agent-row-edit" data-action="remove" data-agent-id="${escapeHtml(a.agentId)}" aria-label="Remove ${escapeHtml(a.agentId)}">Remove</button>
    </div>
  `
}

// ── Add agent form ──────────────────────────────────────────────────

function renderAddAgent(root: HTMLDivElement, controller: AppController, state: AppState): void {
  root.innerHTML = `
    <section class="shell">
      <header class="brand">
        <span class="mark">A</span>
        <div>
          <h1>Add remote agent</h1>
          <p>Connect to a daemon running ${'`agentwfy-server`'}.</p>
        </div>
      </header>
      <form class="form" id="add-form" novalidate>
        <label class="field">
          <span>Local label</span>
          <input name="agentId" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="my-daemon" required />
        </label>
        <label class="field">
          <span>Server URL</span>
          <input name="baseUrl" autocomplete="off" autocapitalize="none" autocorrect="off" inputmode="url" value="http://127.0.0.1:9878" required />
        </label>
        <label class="field">
          <span>Bearer token</span>
          <input name="agentToken" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" required />
        </label>
        <p class="field-error" id="form-error" hidden></p>
        <div class="form-actions">
          <button type="submit" class="primary">Add &amp; connect</button>
          ${state.agents.length > 0 ? `<button type="button" class="ghost" id="cancel">Cancel</button>` : ''}
        </div>
      </form>
      <div class="banner" id="banner" hidden></div>
    </section>
  `

  const form = root.querySelector<HTMLFormElement>('#add-form')!
  const errorEl = root.querySelector<HTMLParagraphElement>('#form-error')!
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    // Lock the button to prevent a double-tap from firing two concurrent
    // addRemoteAgent calls, which would race on the agent-meta read-modify-
    // write helpers and on connect()'s generation counter.
    if (submitBtn.disabled) return
    submitBtn.disabled = true
    errorEl.hidden = true
    const data = new FormData(form)
    let agentId: string
    try {
      agentId = await controller.addRemoteAgent({
        agentId: String(data.get('agentId') ?? ''),
        baseUrl: String(data.get('baseUrl') ?? ''),
        agentToken: String(data.get('agentToken') ?? ''),
      })
    } catch (err) {
      // Save failed (validation or store write). Form is still mounted —
      // surface the message in place and let the user fix and retry.
      submitBtn.disabled = false
      errorEl.hidden = false
      errorEl.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    // Navigate AWAY from the form before kicking off connect. connect()
    // flips the screen to 'chat' and (on failure) bounces back to 'agents'
    // with state.error set — both surface naturally on the destination
    // screen's banner without the form catch having to touch a detached
    // errorEl.
    controller.setScreen('agents')
    void controller.connect(agentId)
  })

  root.querySelector<HTMLButtonElement>('#cancel')?.addEventListener('click', () => {
    controller.setScreen('agents')
  })

  updateBanner(root, state)
}

// ── Connected ────────────────────────────────────────────────────────
//
// Single screen with two stable bodies: a session picker with a first-message
// composer and an active chat. Streaming patches update the message/status
// regions in place so the composer keeps focus and draft text.

type ConnectedBodyMode = 'picker' | 'active'
let bodyMode: ConnectedBodyMode = 'picker'

function renderConnected(root: HTMLDivElement, controller: AppController, state: AppState): void {
  const agentId = state.activeAgentId
  const meta = state.activeMeta
  if (!agentId || !meta) {
    controller.setScreen('agents')
    return
  }

  // Reset transient mode on full re-render (i.e. agent switch / first entry).
  bodyMode = state.activeSession ? 'active' : 'picker'

  root.innerHTML = `
    <section class="shell">
      <header class="brand">
        <span class="mark">A</span>
        <div>
          <h1>${escapeHtml(agentId)}</h1>
          <p>${escapeHtml(displayHost(meta.remoteConfig.baseUrl))}</p>
        </div>
      </header>
      <div class="panel">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Idle</span>
      </div>
      <div class="banner" id="banner" hidden></div>
      <div id="providers-panel"></div>
      <nav class="connected-tabs" id="connected-tabs">
        <button type="button" class="connected-tab" data-screen="chat">Chat</button>
        <button type="button" class="connected-tab" data-screen="views">Views</button>
      </nav>
      <div id="connected-body"></div>
      <div class="form-actions">
        <button type="button" class="ghost" id="disconnect">Disconnect</button>
        <button type="button" class="danger" id="remove">Remove</button>
      </div>
    </section>
  `

  root.querySelector<HTMLButtonElement>('#disconnect')!.addEventListener('click', async () => {
    await controller.disconnect()
    controller.setScreen('agents')
  })
  root.querySelector<HTMLButtonElement>('#remove')!.addEventListener('click', async () => {
    if (!confirm(`Remove agent "${agentId}"?`)) return
    await controller.removeAgent(agentId)
    controller.setScreen('agents')
  })

  root.querySelectorAll<HTMLButtonElement>('.connected-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.screen as Screen | undefined
      if (target === 'chat' || target === 'views') controller.setScreen(target)
    })
  })

  updateProviders(root, state)
  updateConnectedTabs(root, state)
  renderConnectedBody(root, controller, state)
  updateBanner(root, state)
}

function updateConnectedTabs(root: HTMLElement, state: AppState): void {
  const nav = root.querySelector<HTMLElement>('#connected-tabs')
  if (!nav) return
  nav.querySelectorAll<HTMLButtonElement>('.connected-tab').forEach((btn) => {
    const target = btn.dataset.screen
    const active = target === state.screen
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-current', active ? 'page' : 'false')
  })
}

function updateProviders(root: HTMLDivElement, state: AppState): void {
  const panel = root.querySelector<HTMLDivElement>('#providers-panel')
  if (!panel) return
  if (state.activeAgentId === null) return
  panel.innerHTML = renderProvidersHtml(state.providers)
}

function renderProvidersHtml(providers: ProviderState | null): string {
  if (!providers) {
    return `<p class="muted">Loading providers…</p>`
  }
  if (providers.providerList.length === 0) {
    return `
      <div class="banner" data-tone="error">
        No providers configured on this daemon. Configure one in the daemon's settings before starting a session.
      </div>
    `
  }
  const defaultProvider = providers.providerList.find((p) => p.id === providers.defaultProviderId)
  const defaultLabel = defaultProvider ? defaultProvider.name : providers.defaultProviderId || '—'
  const statusByProvider = new Map(providers.providerStatusLines)
  const rows = providers.providerList.map((p) => {
    const line = statusByProvider.get(p.id) ?? ''
    const isDefault = p.id === providers.defaultProviderId
    return `
      <div class="provider-row">
        <span class="provider-name">${escapeHtml(p.name)}${isDefault ? ' <span class="provider-default">default</span>' : ''}</span>
        ${line ? `<span class="provider-status">${escapeHtml(line)}</span>` : ''}
      </div>
    `
  }).join('')
  return `
    <div class="providers">
      <div class="providers-header">
        <span class="providers-title">Providers</span>
        <span class="providers-default">Default: ${escapeHtml(defaultLabel)}</span>
      </div>
      ${rows}
    </div>
  `
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

  renderPickerBody(body, controller, state)
}

// ── Views body ─────────────────────────────────────────────────────
//
// The iframe element is cached at module scope and reattached on each render
// so chat→views→chat round-trips don't tear down the WKWebView and lose
// scroll/form state. The iframe's `src` includes a `viewVersion` query param
// so a controller-side bump (reload, snapshot apply, DB change) forces a
// reload without rebuilding the element.

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
      body.innerHTML = `
        <div class="view-picker">
          <div class="section-header">
            <span class="section-title">Views</span>
          </div>
          <div class="view-list" id="view-list"></div>
        </div>
      `
    } else {
      body.innerHTML = `
        <div class="view-active">
          <div class="section-header">
            <span class="view-active-title" id="view-active-title"></span>
            <div class="view-active-actions">
              <button type="button" class="link" id="view-reload">Reload</button>
              <button type="button" class="link" id="view-close">Close</button>
            </div>
          </div>
          <div class="view-frame-wrap" id="view-frame-wrap"></div>
        </div>
      `
      body.querySelector<HTMLButtonElement>('#view-reload')!.addEventListener('click', () => {
        controller.reloadView()
      })
      body.querySelector<HTMLButtonElement>('#view-close')!.addEventListener('click', () => {
        controller.closeView()
      })
    }
  }

  if (wantMode === 'view-list') {
    const list = body.querySelector<HTMLDivElement>('#view-list')
    if (list) list.innerHTML = renderViewRowsHtml(state.views)
    bindViewRowHandlers(body, controller)
    return
  }

  // Active view: mount/refresh the cached iframe.
  if (!activeName) return
  const wrap = body.querySelector<HTMLDivElement>('#view-frame-wrap')
  if (!wrap) return

  const titleEl = body.querySelector<HTMLSpanElement>('#view-active-title')
  if (titleEl) {
    const summary = state.views.find((v) => v.name === activeName)
    titleEl.textContent = summary?.title || activeName
  }

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
  // tabId carries a stable mobile-only token so the agentview:// handler
  // classifies the request as a view DOCUMENT (vs. a sub-resource fetch);
  // see is_view_document_request in view_protocol.rs. rev bumps to force
  // WKWebView to treat src changes as a fresh navigation.
  return `agentview://localhost/view/${encodeURIComponent(name)}?tabId=mobile-view&rev=${version}`
}

function renderViewRowsHtml(views: ViewSummary[]): string {
  if (views.length === 0) {
    return `<p class="muted">No views yet. Ask the agent to create one.</p>`
  }
  return views.map(renderViewRow).join('')
}

function renderViewRow(v: ViewSummary): string {
  const title = v.title || v.name
  const subtitle = v.title ? v.name : ''
  return `
    <div class="agent-row">
      <button type="button" class="agent-row-main" data-action="open-view" data-view-name="${escapeHtml(v.name)}">
        <span class="agent-label">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="agent-meta">${escapeHtml(subtitle)}</span>` : ''}
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

function renderPickerBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  const providerKey = composerProviderKey(state.providers)
  if (bodyMode !== 'picker' || body.dataset.mode !== 'picker' || body.dataset.providerKey !== providerKey) {
    bodyMode = 'picker'
    body.dataset.mode = 'picker'
    body.dataset.providerKey = providerKey
    delete body.dataset.sessionId
    body.innerHTML = `
      <div class="session-picker">
        <div class="section-header">
          <span class="section-title">Sessions</span>
        </div>
        <div class="session-list" id="session-list"></div>
        ${renderComposerHtml(state, 'start')}
      </div>
    `
    bindComposer(body, controller)
  }
  const list = body.querySelector<HTMLDivElement>('#session-list')
  if (list) list.innerHTML = renderSessionRowsHtml(state.sessions)
  bindSessionRowHandlers(body, controller, state.sessions)
  updateComposerState(body, state)
}

function renderSessionRowsHtml(sessions: SessionSummary[]): string {
  if (sessions.length === 0) {
    return `<p class="muted">No sessions yet. Start one to begin.</p>`
  }
  return sessions.map(renderSessionRow).join('')
}

function renderSessionRow(s: SessionSummary): string {
  const title = s.title || 'Untitled session'
  return `
    <div class="agent-row">
      <button type="button" class="agent-row-main" data-action="open" data-session-id="${escapeHtml(s.sessionId)}">
        <span class="agent-label">${escapeHtml(title)}</span>
        <span class="agent-meta">${escapeHtml(s.providerId || '—')} · ${escapeHtml(formatRelative(s.updatedAt))}</span>
      </button>
      <button type="button" class="agent-row-edit" data-action="remove-session" data-session-id="${escapeHtml(s.sessionId)}" aria-label="Remove session">Remove</button>
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
      const sessionId = btn.dataset.sessionId!
      const target = sessions.find((s) => s.sessionId === sessionId)
      if (!target) return
      const label = target.title || 'this session'
      if (!confirm(`Remove session "${label}"?`)) return
      void controller.removeSession(sessionId)
    })
  })
}

function renderActiveSessionBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  const session = state.activeSession!
  const title = session.title || 'Untitled session'
  if (bodyMode !== 'active' || body.dataset.mode !== 'active' || body.dataset.sessionId !== session.sessionId) {
    bodyMode = 'active'
    body.dataset.mode = 'active'
    body.dataset.sessionId = session.sessionId
    body.innerHTML = `
      <div class="session-active">
        <div class="section-header">
          <button type="button" class="link" id="close-session">Sessions</button>
          <button type="button" class="link danger-link" id="remove-active-session">Remove</button>
        </div>
        <div class="chat-title-row">
          <span class="agent-label" id="session-title"></span>
          <span class="agent-meta" id="session-provider"></span>
        </div>
        <div class="chat-live" id="chat-live"></div>
        <div class="message-list" id="message-list"></div>
        ${renderComposerHtml(state, 'followup')}
      </div>
    `
    body.querySelector<HTMLButtonElement>('#close-session')!.addEventListener('click', () => {
      controller.closeSession()
    })
    body.querySelector<HTMLButtonElement>('#remove-active-session')!.addEventListener('click', () => {
      const current = controller.getState().activeSession
      if (!current) return
      const label = current.title || 'Untitled session'
      if (!confirm(`Remove session "${label}"?`)) return
      void controller.removeSession(current.sessionId)
    })
    bindComposer(body, controller)
  }

  body.querySelector<HTMLSpanElement>('#session-title')!.textContent = title
  body.querySelector<HTMLSpanElement>('#session-provider')!.textContent = session.providerId || 'default provider'
  const live = body.querySelector<HTMLDivElement>('#chat-live')!
  live.innerHTML = renderLiveStatusHtml(state)
  updateMessages(body.querySelector<HTMLDivElement>('#message-list')!, state)
  updateComposerState(body, state)
}

type ComposerMode = 'start' | 'followup'

function renderComposerHtml(state: AppState, mode: ComposerMode): string {
  const providerSelect = mode === 'start' ? renderComposerProviderSelectHtml(state.providers) : ''
  const placeholder = mode === 'start' ? 'Ask the agent anything…' : 'Send a follow-up…'
  const buttonLabel = mode === 'start' ? 'Start chat' : 'Send'
  return `
    <form class="chat-composer" data-mode="${mode}" novalidate>
      ${providerSelect}
      <label class="field composer-field">
        <span>${mode === 'start' ? 'Prompt' : 'Message'}</span>
        <textarea name="prompt" rows="3" autocapitalize="sentences" required placeholder="${placeholder}"></textarea>
      </label>
      <p class="field-error composer-error" hidden></p>
      <p class="composer-hint muted"></p>
      <div class="form-actions composer-actions">
        <button type="submit" class="primary">${buttonLabel}</button>
        <button type="button" class="danger composer-abort" hidden>Abort</button>
      </div>
    </form>
  `
}

function renderComposerProviderSelectHtml(providers: ProviderState | null): string {
  if (!providers || providers.providerList.length <= 1) return ''
  const options = providers.providerList.map((p) => {
    const selected = p.id === providers.defaultProviderId ? 'selected' : ''
    return `<option value="${escapeHtml(p.id)}" ${selected}>${escapeHtml(p.name)}</option>`
  }).join('')
  return `
    <label class="field">
      <span>Provider</span>
      <select name="providerId">${options}</select>
    </label>
  `
}

function composerProviderKey(providers: ProviderState | null): string {
  if (!providers) return 'loading'
  return `${providers.defaultProviderId}\0${providers.providerList.map((p) => p.id).join('\0')}`
}

function bindComposer(scope: HTMLElement, controller: AppController): void {
  const form = scope.querySelector<HTMLFormElement>('.chat-composer')
  if (!form) return
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!
  const errorEl = form.querySelector<HTMLParagraphElement>('.composer-error')!
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const abortBtn = form.querySelector<HTMLButtonElement>('.composer-abort')!

  textarea.addEventListener('input', () => {
    autoSizeTextarea(textarea)
    errorEl.hidden = true
  })

  form.addEventListener('submit', (evt) => {
    evt.preventDefault()
    if (submitBtn.disabled) return
    const prompt = textarea.value.trim()
    if (!prompt) {
      errorEl.hidden = false
      errorEl.textContent = 'Prompt is required.'
      textarea.focus()
      return
    }
    const data = new FormData(form)
    const providerId = data.get('providerId')
    form.dataset.sending = 'true'
    submitBtn.disabled = true
    errorEl.hidden = true
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
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  const abortBtn = form.querySelector<HTMLButtonElement>('.composer-abort')
  const hint = form.querySelector<HTMLParagraphElement>('.composer-hint')
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
    return `<div class="empty-chat muted">No messages yet.</div>`
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
      return `<div class="message-text">${escapeTextBlock(block.text)}</div>`
    case 'thinking':
      return `<details class="thinking-block"><summary>Thinking</summary><div>${escapeTextBlock(block.text)}</div></details>`
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
      return `<div class="message-error">${escapeTextBlock(block.text)}</div>`
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

function renderLiveStatusHtml(state: AppState): string {
  const live = state.activeSession?.live
  if (state.status.state !== 'connected') {
    return `<div class="chat-live-row" data-tone="error">${escapeHtml(state.status.message || 'Disconnected')}</div>`
  }
  if (live?.retryState) {
    return `<div class="chat-live-row" data-tone="warn">${escapeHtml(formatRetry(live.retryState))}</div>`
  }
  if (live?.stalledSince) {
    return `<div class="chat-live-row" data-tone="warn">No response for ${escapeHtml(formatDuration(Date.now() - live.stalledSince))}.</div>`
  }
  if (live?.statusLine) {
    return `<div class="chat-live-row">${escapeHtml(live.statusLine)}</div>`
  }
  if (live?.isStreaming) {
    return `<div class="chat-live-row">Streaming response…</div>`
  }
  return `<div class="chat-live-row">Ready</div>`
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

function escapeTextBlock(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

function autoSizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(160, Math.max(72, textarea.scrollHeight))}px`
}

// Compact "5m ago" formatter — enough to spot stale sessions in the picker.
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

// ── Shared status / banner ─────────────────────────────────────────

function updateBanner(root: HTMLDivElement, state: AppState): void {
  const banner = root.querySelector<HTMLDivElement>('#banner')
  if (banner) {
    const message = bannerMessage(state)
    if (message) {
      banner.hidden = false
      banner.textContent = message
      banner.dataset.tone = bannerTone(state)
    } else {
      banner.hidden = true
      banner.textContent = ''
    }
  }

  const statusText = root.querySelector<HTMLSpanElement>('#status-text')
  const statusDot = root.querySelector<HTMLSpanElement>('#status-dot')
  if (statusText) statusText.textContent = formatStatus(state)
  if (statusDot) statusDot.dataset.state = state.status.state
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

// ── Small utilities ────────────────────────────────────────────────

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
