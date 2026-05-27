// List of agent views available on the connected daemon. On mount,
// queries the local SQLite mirror for `views` rows. Listens for
// db-change / snapshot-applied / agent-switched to refresh. Tapping a
// row dispatches open-view.

import { backendSession } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import { bridge } from '../tauri-bridge.js'
import { escapeHtml } from './util.js'

interface ViewRow { name: string; title: string | null }

export class TlViewList extends HTMLElement {
  private listEl!: HTMLDivElement
  private rows: ViewRow[] = []
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.innerHTML = `<div class="scroll-list" data-role="list"></div>`
    this.listEl = this.querySelector<HTMLDivElement>('[data-role="list"]')!

    this.unsubs.push(
      listen('db-change', ({ change }) => {
        if (change.table === 'views') void this.refresh()
      }),
      listen('snapshot-applied', () => { void this.refresh() }),
      listen('agent-switched', () => { this.rows = []; this.render(); void this.refresh() }),
    )

    void this.refresh()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  private async refresh(): Promise<void> {
    const agentId = backendSession.getActiveAgentId()
    if (!agentId) {
      this.rows = []
      this.render()
      return
    }
    try {
      // Mirror the ORDER BY used by shared/db/views.ts:listViews so this
      // matches what desktop's command palette / source explorer show.
      const rows = await bridge.mirrorDb.query(
        agentId,
        `SELECT name, title FROM views
ORDER BY
  CASE
    WHEN name NOT LIKE 'system.%' AND name NOT LIKE 'plugin.%' THEN 0
    WHEN name LIKE 'system.%' THEN 1
    WHEN name LIKE 'plugin.%' THEN 2
  END,
  updated_at DESC`,
      )
      // The active agent may have changed during the await. If it did,
      // these rows are from the previous agent — drop them so we don't
      // show or open views that don't belong to the current agent.
      if (backendSession.getActiveAgentId() !== agentId) return
      this.rows = rows.map((row) => ({
        name: String(row.name ?? ''),
        title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      })).filter((v) => v.name.length > 0)
    } catch {
      // Mirror DB might not be open yet — leave rows alone; the snapshot
      // listener will retry.
    }
    this.render()
  }

  private render() {
    this.listEl.innerHTML = renderRowsHtml(this.rows)
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.viewName
        if (name) dispatch('open-view', { name })
      })
    })
  }
}

function renderRowsHtml(views: ViewRow[]): string {
  if (views.length === 0) {
    return `<div class="empty-list">No views yet. Ask the agent to create one.</div>`
  }
  return views.map(renderRow).join('')
}

function renderRow(v: ViewRow): string {
  const title = v.title || v.name
  const subtitle = v.title ? v.name : ''
  return `
    <div class="row">
      <button type="button" class="row-main" data-action="open" data-view-name="${escapeHtml(v.name)}">
        <span class="row-title">${escapeHtml(title)}</span>
        ${subtitle ? `<span class="row-meta">${escapeHtml(subtitle)}</span>` : ''}
      </button>
    </div>
  `
}
