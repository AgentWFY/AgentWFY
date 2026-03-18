import { escapeHtml } from './chat_utils.js'

const STYLES = `
  .settings {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 4px 0;
    font-size: 13px;
  }
  .section {
    padding: 10px 0;
  }
  .section + .section {
    border-top: 1px solid var(--color-divider);
  }
  .section-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .field-label {
    font-size: 11px;
    color: var(--color-text2);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .field input {
    padding: 5px 8px;
    border: 1px solid var(--color-input-border);
    border-radius: var(--radius-sm);
    background: var(--color-input-bg);
    font-size: 13px;
    outline: none;
  }
  .field input:focus {
    border-color: var(--color-focus-border);
  }
  .key-row {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .key-row input {
    flex: 1;
    min-width: 0;
  }
  .btn {
    padding: 4px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg3);
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text3);
    white-space: nowrap;
  }
  .btn:hover { background: var(--color-item-hover); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn-accent {
    background: var(--color-accent);
    color: var(--color-bg1);
    border-color: var(--color-accent);
  }
  .btn-accent:hover { opacity: 0.9; }
`

/**
 * Minimal settings component that reads/writes provider config
 * from the config table via SQL.
 */
export class TlAgentSettings extends HTMLElement {
  private _disabled = false
  private apiKeyInput = ''
  private modelIdInput = ''
  private baseUrlInput = ''
  private loaded = false
  private _renderQueued = false

  get disabled(): boolean { return this._disabled }
  set disabled(val: boolean) {
    this._disabled = val
    this.queueRender()
  }

  connectedCallback() {
    this.loadConfig()
  }

  private queueRender() {
    if (this._renderQueued) return
    this._renderQueued = true
    queueMicrotask(() => {
      this._renderQueued = false
      this.render()
    })
  }

  private async loadConfig() {
    try {
      const ipc = window.ipc
      if (!ipc) return

      const rows = await ipc.sql.run({
        target: 'agent',
        sql: "SELECT name, value FROM config WHERE name LIKE 'system.openai-compatible-provider.%'",
        description: 'Load provider config',
      }) as Array<{ name: string; value: string | null }>

      for (const row of rows) {
        const val = row.value ? JSON.parse(row.value) : ''
        switch (row.name) {
          case 'system.openai-compatible-provider.apiKey': this.apiKeyInput = val; break
          case 'system.openai-compatible-provider.modelId': this.modelIdInput = val; break
          case 'system.openai-compatible-provider.baseUrl': this.baseUrlInput = val; break
        }
      }
    } catch {
      // Config not set yet
    }
    this.loaded = true
    this.render()
  }

  private async saveConfigValue(name: string, value: string) {
    const ipc = window.ipc
    if (!ipc) return

    const jsonValue = JSON.stringify(value)
    await ipc.sql.run({
      target: 'agent',
      sql: `UPDATE config SET value = ? WHERE name = ?`,
      params: [jsonValue, name],
      description: `Save config ${name}`,
    })
  }

  private async handleSaveApiKey() {
    const key = this.apiKeyInput.trim()
    if (!key) return
    await this.saveConfigValue('system.openai-compatible-provider.apiKey', key)
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private async handleSaveModel() {
    const modelId = this.modelIdInput.trim()
    if (!modelId) return
    await this.saveConfigValue('system.openai-compatible-provider.modelId', modelId)
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private async handleSaveBaseUrl() {
    const baseUrl = this.baseUrlInput.trim()
    await this.saveConfigValue('system.openai-compatible-provider.baseUrl', baseUrl || 'https://openrouter.ai/api')
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  render() {
    if (!this.loaded) {
      this.innerHTML = ''
      return
    }

    const disabled = this._disabled
    const disabledAttr = disabled ? 'disabled' : ''

    this.innerHTML = `
      <style>${STYLES}</style>
      <div class="settings">
        <div class="section">
          <div class="section-body">
            <div class="field">
              <span class="field-label">API Key</span>
              <div class="key-row">
                <input
                  type="password"
                  value="${escapeHtml(this.apiKeyInput)}"
                  placeholder="sk-..."
                  ${disabledAttr}
                  data-action="api-key-input"
                >
                <button class="btn btn-accent" ${disabledAttr} data-action="save-api-key">Save</button>
              </div>
            </div>
            <div class="field">
              <span class="field-label">Model</span>
              <div class="key-row">
                <input
                  type="text"
                  value="${escapeHtml(this.modelIdInput)}"
                  placeholder="moonshotai/kimi-k2.5"
                  ${disabledAttr}
                  data-action="model-input"
                >
                <button class="btn" ${disabledAttr} data-action="save-model">Save</button>
              </div>
            </div>
            <div class="field">
              <span class="field-label">Base URL</span>
              <div class="key-row">
                <input
                  type="text"
                  value="${escapeHtml(this.baseUrlInput)}"
                  placeholder="https://openrouter.ai/api"
                  ${disabledAttr}
                  data-action="base-url-input"
                >
                <button class="btn" ${disabledAttr} data-action="save-base-url">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>`

    this.attachListeners()
  }

  private attachListeners() {
    const q = (sel: string) => this.querySelector(sel)

    const apiKeyInput = q('[data-action="api-key-input"]') as HTMLInputElement | null
    if (apiKeyInput) {
      apiKeyInput.addEventListener('input', (e: Event) => {
        this.apiKeyInput = (e.target as HTMLInputElement).value
      })
      apiKeyInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.handleSaveApiKey()
      })
    }

    const saveBtn = q('[data-action="save-api-key"]')
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.handleSaveApiKey())
    }

    const modelInput = q('[data-action="model-input"]') as HTMLInputElement | null
    if (modelInput) {
      modelInput.addEventListener('input', (e: Event) => {
        this.modelIdInput = (e.target as HTMLInputElement).value
      })
      modelInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.handleSaveModel()
      })
    }

    const saveModelBtn = q('[data-action="save-model"]')
    if (saveModelBtn) {
      saveModelBtn.addEventListener('click', () => this.handleSaveModel())
    }

    const baseUrlInput = q('[data-action="base-url-input"]') as HTMLInputElement | null
    if (baseUrlInput) {
      baseUrlInput.addEventListener('input', (e: Event) => {
        this.baseUrlInput = (e.target as HTMLInputElement).value
      })
      baseUrlInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.handleSaveBaseUrl()
      })
    }

    const saveBaseUrlBtn = q('[data-action="save-base-url"]')
    if (saveBaseUrlBtn) {
      saveBaseUrlBtn.addEventListener('click', () => this.handleSaveBaseUrl())
    }
  }
}
