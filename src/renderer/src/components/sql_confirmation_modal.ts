import type { PendingSqlConfirmation } from 'app/types'
import {
  confirmPendingSqlConfirmation,
  cancelPendingSqlConfirmation,
} from 'app/interactors/sql'

export class TlSqlModal extends HTMLElement {
  private _pending: PendingSqlConfirmation | null = null
  private wrapperEl!: HTMLDivElement
  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cancelPendingSqlConfirmation()
    }
  }

  connectedCallback() {
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
      <sp-dialog-base open underlay>
        <sp-dialog no-divider size="m">
          <div style="padding:16px;">
            <h3 style="margin:0 0 16px 0;color:var(--spectrum-global-color-gray-900);">SQL Confirmation</h3>
            <div style="margin-bottom:12px;">
              <span style="display:block;font-size:12px;color:var(--spectrum-global-color-gray-600);margin-bottom:4px;">From:</span>
              <span style="color:var(--spectrum-global-color-gray-900);">${this.escapeHtml(this.getSenderLabel(p.sender))}</span>
            </div>`

    if (p.description) {
      html += `
            <div style="margin-bottom:12px;">
              <span style="display:block;font-size:12px;color:var(--spectrum-global-color-gray-600);margin-bottom:4px;">Description:</span>
              <span style="color:var(--spectrum-global-color-gray-900);">${this.escapeHtml(p.description)}</span>
            </div>`
    }

    html += `
            <div style="margin-bottom:12px;">
              <span style="display:block;font-size:12px;color:var(--spectrum-global-color-gray-600);margin-bottom:4px;">SQL:</span>
              <pre style="background:var(--spectrum-global-color-gray-200);padding:8px 12px;border-radius:4px;overflow-x:auto;font-size:13px;margin:0;white-space:pre-wrap;word-break:break-all;">${this.escapeHtml(p.sql)}</pre>
            </div>`

    if (p.params && p.params.length > 0) {
      html += `
            <div style="margin-bottom:12px;">
              <span style="display:block;font-size:12px;color:var(--spectrum-global-color-gray-600);margin-bottom:4px;">Params:</span>
              <pre style="background:var(--spectrum-global-color-gray-200);padding:8px 12px;border-radius:4px;overflow-x:auto;font-size:13px;margin:0;white-space:pre-wrap;word-break:break-all;">${this.escapeHtml(JSON.stringify(p.params, null, 2))}</pre>
            </div>`
    }

    html += `
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
              <sp-button variant="secondary" id="sql-cancel-btn">Cancel</sp-button>
              <sp-button variant="cta" id="sql-confirm-btn">Confirm</sp-button>
            </div>
          </div>
        </sp-dialog>
      </sp-dialog-base>`

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
