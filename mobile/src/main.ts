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

import type { ProviderInfo } from '#shared/agent/provider_types.js'
import type { ProviderState, SessionSummary } from '#shared/backend/interface.js'
import { AppController, type AppState, type InstalledAgent, type Screen } from './app-controller.js'

const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  const controller = new AppController()
  bootstrap(controller, app).catch((err) => {
    console.error('[mobile] bootstrap failed:', err)
  })
}

async function bootstrap(controller: AppController, root: HTMLDivElement): Promise<void> {
  await controller.refreshAgents()
  const agents = controller.getState().agents

  // First-launch UX: jump straight into the add-agent form when nothing's
  // configured. Mirrors desktop "no installed agents -> create a default
  // agent" (main.ts), adapted for remote-only.
  if (agents.length === 0) controller.setScreen('add-agent')

  let lastScreen: Screen | null = null
  let lastActiveAgentId: string | null | undefined
  controller.subscribe((state) => {
    // Re-render the whole screen on screen / active-agent transitions.
    // Within a screen, partial updaters refresh just status and banners.
    if (state.screen !== lastScreen || state.activeAgentId !== lastActiveAgentId) {
      lastScreen = state.screen
      lastActiveAgentId = state.activeAgentId
      renderScreen(root, controller, state)
    } else {
      updateBanner(root, state)
      updateAgentsList(root, controller, state)
      renderConnectedBody(root, controller, state)
      updateProviders(root, state)
    }
  })
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
// Single screen with three swappable bodies: a picker (sessions + provider
// summary + "New session" button), an active-session placeholder (filled in
// by Step 5), and a new-session prompt form. The form is the only piece of
// transient UI state that isn't a function of AppState — `bodyMode` tracks
// it so subscribe-fallthrough updates don't clobber an in-flight prompt.

type ConnectedBodyMode = 'picker' | 'active' | 'new'
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

  updateProviders(root, state)
  renderConnectedBody(root, controller, state)
  updateBanner(root, state)
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

  // Don't replace the new-session form while the user is typing into it;
  // only flip out once an activeSession has actually been loaded (i.e. the
  // spawn the form initiated succeeded).
  if (bodyMode === 'new' && !state.activeSession) return

  if (state.activeSession) {
    bodyMode = 'active'
    renderActiveSessionBody(body, controller, state)
    return
  }

  bodyMode = 'picker'
  renderPickerBody(body, controller, state)
}

function renderPickerBody(body: HTMLDivElement, controller: AppController, state: AppState): void {
  body.innerHTML = `
    <div class="session-picker">
      <div class="section-header">
        <span class="section-title">Sessions</span>
        <button type="button" class="link" id="new-session">New session</button>
      </div>
      <div class="session-list" id="session-list">${renderSessionRowsHtml(state.sessions)}</div>
    </div>
  `
  body.querySelector<HTMLButtonElement>('#new-session')!.addEventListener('click', () => {
    bodyMode = 'new'
    renderNewSessionForm(body, controller, state)
  })
  bindSessionRowHandlers(body, controller, state.sessions)
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
  body.innerHTML = `
    <div class="session-active">
      <div class="section-header">
        <button type="button" class="link" id="close-session">← Sessions</button>
      </div>
      <div class="panel">
        <span class="agent-label">${escapeHtml(title)}</span>
      </div>
      <p class="muted">Session loaded (${escapeHtml(String(session.messages.length))} message${session.messages.length === 1 ? '' : 's'}). Chat rendering lands in the next plan step.</p>
      <div class="form-actions">
        <button type="button" class="danger" id="remove-active-session">Remove session</button>
      </div>
    </div>
  `
  body.querySelector<HTMLButtonElement>('#close-session')!.addEventListener('click', () => {
    controller.closeSession()
  })
  body.querySelector<HTMLButtonElement>('#remove-active-session')!.addEventListener('click', () => {
    if (!confirm(`Remove session "${title}"?`)) return
    void controller.removeSession(session.sessionId)
  })
}

function renderNewSessionForm(body: HTMLDivElement, controller: AppController, state: AppState): void {
  const providers = state.providers
  const providerOptions = providers
    ? providers.providerList.map((p: ProviderInfo) => {
        const selected = p.id === providers.defaultProviderId ? 'selected' : ''
        return `<option value="${escapeHtml(p.id)}" ${selected}>${escapeHtml(p.name)}</option>`
      }).join('')
    : ''
  body.innerHTML = `
    <form class="form" id="new-session-form" novalidate>
      <div class="section-header">
        <span class="section-title">New session</span>
        <button type="button" class="link" id="cancel-new-session">Cancel</button>
      </div>
      ${providers && providers.providerList.length > 1 ? `
        <label class="field">
          <span>Provider</span>
          <select name="providerId">${providerOptions}</select>
        </label>
      ` : ''}
      <label class="field">
        <span>Prompt</span>
        <textarea name="prompt" rows="4" autocapitalize="sentences" required placeholder="Ask the agent anything…"></textarea>
      </label>
      <p class="field-error" id="new-session-error" hidden></p>
      <div class="form-actions">
        <button type="submit" class="primary">Start session</button>
      </div>
    </form>
  `
  const form = body.querySelector<HTMLFormElement>('#new-session-form')!
  const errorEl = body.querySelector<HTMLParagraphElement>('#new-session-error')!
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!

  body.querySelector<HTMLButtonElement>('#cancel-new-session')!.addEventListener('click', () => {
    bodyMode = 'picker'
    renderPickerBody(body, controller, controller.getState())
  })

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    if (submitBtn.disabled) return
    const data = new FormData(form)
    const prompt = String(data.get('prompt') ?? '').trim()
    if (!prompt) {
      errorEl.hidden = false
      errorEl.textContent = 'Prompt is required.'
      return
    }
    const providerId = data.get('providerId')
    submitBtn.disabled = true
    errorEl.hidden = true

    const sessionId = await controller.newSession({
      prompt,
      providerId: providerId ? String(providerId) : undefined,
    })

    if (!sessionId) {
      // Failure path: controller patched state.error → banner shows it.
      // Keep the form mounted so the user can retry with their typed prompt.
      submitBtn.disabled = false
      bodyMode = 'new'
      return
    }
    // Success: controller has loaded the new session, so the next subscribe
    // tick will flip bodyMode to 'active' and re-render the body.
  })
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
