// List of agent views available on the connected daemon. Tap a row to
// open the view in awfy-view-frame.

import { controller } from '../controller.js'
import type { AppState, ViewSummary } from '../app-state.js'
import { escapeHtml } from './util.js'

export class TlViewList extends HTMLElement {
  private listEl!: HTMLDivElement
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.innerHTML = `<div class="scroll-list" data-role="list"></div>`
    this.listEl = this.querySelector<HTMLDivElement>('[data-role="list"]')!
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    this.listEl.innerHTML = renderRowsHtml(state.views)
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.viewName
        if (name) controller.openView(name)
      })
    })
  }
}

function renderRowsHtml(views: ViewSummary[]): string {
  if (views.length === 0) {
    return `<div class="empty-list">No views yet. Ask the agent to create one.</div>`
  }
  return views.map(renderRow).join('')
}

function renderRow(v: ViewSummary): string {
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
