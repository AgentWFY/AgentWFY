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

// ── Connected (placeholder until chat lands in Step 5) ───────────────

function renderConnected(root: HTMLDivElement, controller: AppController, state: AppState): void {
  const agentId = state.activeAgentId
  const meta = state.activeMeta
  if (!agentId || !meta) {
    controller.setScreen('agents')
    return
  }

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
      <p class="muted">Chat and view surfaces land in the next plan steps.</p>
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

  updateBanner(root, state)
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
