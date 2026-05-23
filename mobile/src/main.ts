// Debug shell for Step 6: lets you point at a daemon, start the backend, and
// run a SELECT against the local mirror to confirm the snapshot landed and
// `db:changed` events are flowing. A real touch-first UI replaces this in
// Step 8.

import type { AgentBackend } from '#shared/backend/interface.js'
import { bridge } from './tauri-bridge.js'
import { createMobileBackend, type MobileBackend } from './backend.js'

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

  let session: MobileBackend | null = null
  let statusUnsubscribe: (() => void) | null = null

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault()
    const data = new FormData(form)
    const agentId = String(data.get('agentId') ?? '').trim()
    const baseUrl = String(data.get('baseUrl') ?? '').trim()
    const agentToken = String(data.get('agentToken') ?? '').trim()
    if (!agentId || !baseUrl || !agentToken) return

    statusUnsubscribe?.()
    statusUnsubscribe = null
    if (session) {
      await session.stop().catch(() => {})
      session = null
    }
    statusText.textContent = 'Connecting…'
    try {
      session = await createMobileBackend({
        agentId,
        baseUrl,
        agentToken,
        onLocalDbChange: (change) => {
          statusText.textContent = `Change applied: ${change.op} ${change.table}/${change.rowId} (v${change.version})`
        },
        onSnapshotApplied: () => {
          statusText.textContent = 'Snapshot applied'
        },
      })
      runButton.disabled = false
      openViewButton.disabled = false
      statusUnsubscribe = session.backend.status.subscribe((s) => {
        statusText.textContent = `Backend: ${s.state}${s.message ? ` — ${s.message}` : ''}`
      })
    } catch (err) {
      statusText.textContent = `Connect failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })

  viewForm.addEventListener('submit', (evt) => {
    evt.preventDefault()
    const viewName = String(new FormData(viewForm).get('viewName') ?? '').trim()
    if (!viewName) return
    // Bypasses the iframe's history; setting src to the same URL re-fetches.
    viewFrame.src = `agentview://view/${encodeURIComponent(viewName)}`
  })

  runButton.addEventListener('click', async () => {
    const agentId = String(new FormData(form).get('agentId') ?? '').trim()
    if (!agentId) return
    try {
      const rows = await bridge.mirrorDb.query(
        agentId,
        'SELECT name, title, length(content) AS content_len FROM views ORDER BY name',
      )
      output.textContent = JSON.stringify(rows, null, 2)
    } catch (err) {
      output.textContent = `Query failed: ${err instanceof Error ? err.message : String(err)}`
    }
  })
}

export type { AgentBackend }
export { bridge }
