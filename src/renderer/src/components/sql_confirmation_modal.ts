import type { PendingSqlConfirmation } from 'app/types'
import {
  confirmPendingSqlConfirmation,
  cancelPendingSqlConfirmation,
} from 'app/interactors/sql'

const MODAL_STYLES = `
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--color-modal-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .modal-panel {
    background: var(--color-modal-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--color-modal-shadow);
    max-width: 560px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    padding: 16px;
  }
  .modal-panel h3 {
    margin: 0 0 16px 0;
    color: var(--color-text4);
  }
  .modal-label {
    display: block;
    font-size: 12px;
    color: var(--color-text2);
    margin-bottom: 4px;
  }
  .modal-value {
    color: var(--color-text4);
  }
  .modal-field {
    margin-bottom: 12px;
  }
  .modal-sql {
    background: var(--color-code-bg);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-size: 13px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--font-mono);
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
`

export class TlSqlModal extends HTMLElement {
  private _pending: PendingSqlConfirmation | null = null
  private wrapperEl!: HTMLDivElement
  private styleEl!: HTMLStyleElement
  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelPendingSqlConfirmation()
    }
  }

  connectedCallback() {
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = MODAL_STYLES
    this.appendChild(this.styleEl)

    this.wrapperEl = document.createElement('div')
    this.appendChild(this.wrapperEl)
    window.addEventListener('keydown', this.onKeydown)
    this.render()
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.onKeydown)
  }

  set pending(value: PendingSqlConfirmation | null) {
    this._pending = value
    this.render()
  }

  get pending() { return this._pending }

  private getSenderLabel(sender: string): string {
    if (sender === 'ai-agent') return 'AI Agent'
    if (sender === 'client-app') return sender
    return `View: ${sender}`
  }

  private render() {
    if (!this.wrapperEl) return

    if (!this._pending) {
      this.wrapperEl.innerHTML = ''
      return
    }

    const p = this._pending

    let html = `
      <div class="modal-overlay">
        <div class="modal-panel">
          <h3>SQL Confirmation</h3>
          <div class="modal-field">
            <span class="modal-label">From:</span>
            <span class="modal-value">${this.escapeHtml(this.getSenderLabel(p.sender))}</span>
          </div>`

    if (p.description) {
      html += `
          <div class="modal-field">
            <span class="modal-label">Description:</span>
            <span class="modal-value">${this.escapeHtml(p.description)}</span>
          </div>`
    }

    html += `
          <div class="modal-field">
            <span class="modal-label">SQL:</span>
            <pre class="modal-sql">${this.escapeHtml(p.sql)}</pre>
          </div>`

    if (p.params && p.params.length > 0) {
      html += `
          <div class="modal-field">
            <span class="modal-label">Params:</span>
            <pre class="modal-sql">${this.escapeHtml(JSON.stringify(p.params, null, 2))}</pre>
          </div>`
    }

    html += `
          <div class="modal-actions">
            <button class="btn" id="sql-cancel-btn">Cancel</button>
            <button class="btn btn-accent" id="sql-confirm-btn">Confirm</button>
          </div>
        </div>
      </div>`

    this.wrapperEl.innerHTML = html

    this.wrapperEl.querySelector('#sql-cancel-btn')?.addEventListener('click', () => {
      cancelPendingSqlConfirmation()
    })
    this.wrapperEl.querySelector('#sql-confirm-btn')?.addEventListener('click', () => {
      confirmPendingSqlConfirmation()
    })
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }
}
