// Debug shell that drives the AppController. The form, run-query, and view
// frame are still debug aids — Step 3 replaces them with proper profile and
// chat screens. The point of this file at Step 2 is to prove the controller
// is enough: connect, status, and snapshot observation all flow through
// AppController.subscribe / AppController.connect rather than touching the
// backend directly.

import type { AgentBackend } from '#shared/backend/interface.js'
import { bridge } from './tauri-bridge.js'
import { AppController } from './app-controller.js'

const app = document.querySelector<HTMLDivElement>('#app')
if (app) {
  app.innerHTML = `
    <section class="shell">
      <div class="brand">
        <span class="mark">A</span>
        <div>
          <h1>AgentWFY Mobile</h1>
          <p>Debug mirror harness</p>
        </div>
      </div>
      <form class="panel" id="connect-form">
        <label>
          Agent ID
          <input name="agentId" value="local" required />
        </label>
        <label>
          Daemon URL
          <input name="baseUrl" value="http://127.0.0.1:9878" required />
        </label>
        <label>
          Agent token
          <input name="agentToken" required />
        </label>
        <button type="submit">Connect</button>
      </form>
      <div class="panel">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Idle</span>
        <button type="button" id="run-query" disabled>Run SELECT * FROM views</button>
      </div>
      <pre id="output">—</pre>
      <form class="panel" id="view-form">
        <label>
          View name
          <input name="viewName" placeholder="dashboard" />
        </label>
        <button type="submit" disabled id="open-view">Render view</button>
      </form>
      <iframe id="view-frame" sandbox="allow-scripts" style="width:100%;height:60vh;border:1px solid var(--color-border, #ccc)"></iframe>
    </section>
  `

  const form = document.getElementById('connect-form') as HTMLFormElement
  const statusText = document.getElementById('status-text') as HTMLElement
  const runButton = document.getElementById('run-query') as HTMLButtonElement
  const output = document.getElementById('output') as HTMLElement
  const viewForm = document.getElementById('view-form') as HTMLFormElement
  const openViewButton = document.getElementById('open-view') as HTMLButtonElement
  const viewFrame = document.getElementById('view-frame') as HTMLIFrameElement

  const controller = new AppController()

  controller.subscribe((state) => {
    // Mirror ready (snapshot has landed) is what gates the debug query and
    // view-render buttons — not WS-connected. RemoteBackend.start() returns
    // before the WS hello, so a slow hello shouldn't lock the user out of
    // the local mirror.
    const mirrorReady = state.lastSyncAt !== null && !state.error
    runButton.disabled = !mirrorReady
    openViewButton.disabled = !mirrorReady

    statusText.textContent = formatStatus(state)
  })

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    const data = new FormData(form)
    const agentId = String(data.get('agentId') ?? '').trim()
    const baseUrl = String(data.get('baseUrl') ?? '').trim()
    const agentToken = String(data.get('agentToken') ?? '').trim()
    if (!agentId || !baseUrl || !agentToken) return
    await controller.connect({ agentId, baseUrl, agentToken })
  })

  viewForm.addEventListener('submit', (evt) => {
    evt.preventDefault()
    const viewName = String(new FormData(viewForm).get('viewName') ?? '').trim()
    if (!viewName) return
    // Path-based routing matching desktop (https://<hash>.views.agentwfy.local/...).
    // Mobile keeps the agentview:// scheme because iOS WKURLSchemeHandler
    // can't claim http/https; hostname is ignored, the path drives the route.
    // tabId marks this as a document request (not a sub-resource fetch).
    const rev = Date.now()
    viewFrame.src = `agentview://localhost/view/${encodeURIComponent(viewName)}?tabId=mobile&rev=${rev}`
  })

  runButton.addEventListener('click', async () => {
    const profile = controller.getState().profile
    if (!profile) return
    try {
      const rows = await bridge.mirrorDb.query(
        profile.agentId,
        'SELECT name, title, length(content) AS content_len FROM views ORDER BY name',
      )
      output.textContent = JSON.stringify(rows, null, 2)
    } catch (err) {
      output.textContent = `Query failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })
}

function formatStatus(state: ReturnType<AppController['getState']>): string {
  if (state.error) return `Connect failed: ${state.error}`
  // Before any connect attempt the controller's status is the bare
  // IDLE_STATUS — show plain "Idle" rather than "Backend: disconnected".
  if (state.profile === null && state.status.state === 'disconnected') return 'Idle'
  const base = `Backend: ${state.status.state}${state.status.message ? ` — ${state.status.message}` : ''}`
  const tail = describeRecentActivity(state)
  return tail ? `${base} • ${tail}` : base
}

function describeRecentActivity(state: ReturnType<AppController['getState']>): string | null {
  if (state.lastDbChange) {
    const c = state.lastDbChange
    return `change: ${c.op} ${c.table}/${c.rowId} (v${c.version})`
  }
  if (state.lastSyncAt !== null) return 'snapshot applied'
  return null
}

export type { AgentBackend }
export { bridge }
