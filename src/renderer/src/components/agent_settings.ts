import { getProviderIds } from '../agent/models.js'
import type { ThinkingLevel } from '../agent/types.js'
import type { AgentAuthConfig, AuthMethod } from '../agent/agent_auth.js'
import {
  safeGetModels,
  saveAuthConfig,
  getAvailableOAuthProviders,
  performOAuthLogin,
  isOAuthConnected,
  getProviderForAuthMethod,
  normalizeAuthConfig,
  logoutOAuth,
} from '../agent/agent_auth.js'

const STYLES = `
  .settings {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 4px 0;
    font-size: 13px;
  }

  /* ── Sections ── */

  .section {
    padding: 10px 0;
  }
  .section + .section {
    border-top: 1px solid var(--color-border);
  }
  .section-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── Grid and fields ── */

  .field-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .field-label {
    font-size: 10px;
    color: var(--color-text2);
    letter-spacing: 0.3px;
  }

  /* ── API key row ── */

  .key-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .key-row input {
    flex: 1;
    min-width: 0;
  }
  .key-row .btn {
    flex-shrink: 0;
  }

  /* ── OAuth ── */

  .oauth-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-text2);
  }
  .oauth-error-row {
    font-size: 12px;
    color: var(--color-red-fg);
  }
  .oauth-link {
    font-size: 11px;
    color: var(--color-accent);
    word-break: break-all;
  }
  .oauth-link a { color: inherit; }
  .connected-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .connected-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-green-fg);
    flex-shrink: 0;
  }
  .connected-text {
    font-size: 12px;
    color: var(--color-green-fg);
    font-weight: 500;
  }

`

const oauthProviders = getAvailableOAuthProviders()
const authMethods: { id: AuthMethod; label: string }[] = [
  { id: 'api-key', label: 'API Key' },
  ...oauthProviders.map(p => ({ id: p.id, label: p.name })),
]
const thinkingLevels: ThinkingLevel[] = ['off' as ThinkingLevel, 'minimal', 'low', 'medium', 'high', 'xhigh']

function getModelIdForProvider(provider: string, currentModelId: string): string {
  const models = safeGetModels(provider)
  if (models.some((model) => model.id === currentModelId)) {
    return currentModelId
  }
  return models.length > 0 ? models[0].id : ''
}

export class TlAgentSettings extends HTMLElement {
  private _authConfig!: AgentAuthConfig
  private _disabled = false
  private apiKeyInput = ''
  private oauthStatus = ''
  private oauthError = ''
  private isLoggingIn = false
  private oauthAuthUrl = ''
  private oauthCodeInput = ''
  private oauthInstructions = ''
  private awaitingCode = false
  private resolveCodePromise: ((code: string) => void) | null = null

  private _renderQueued = false

  get authConfig(): AgentAuthConfig { return this._authConfig }
  set authConfig(val: AgentAuthConfig) {
    this._authConfig = normalizeAuthConfig(val)
    this.apiKeyInput = val.apiKey ?? ''
    this.queueRender()
  }

  get disabled(): boolean { return this._disabled }
  set disabled(val: boolean) {
    this._disabled = val
    this.queueRender()
  }

  connectedCallback() {
    this.render()
  }

  private queueRender() {
    if (this._renderQueued) return
    this._renderQueued = true
    queueMicrotask(() => {
      this._renderQueued = false
      this.render()
    })
  }

  private get isOAuth() {
    return this._authConfig?.authMethod !== 'api-key'
  }

  private get connected() {
    return this._authConfig ? isOAuthConnected(this._authConfig) : false
  }

  private get lockedProvider() {
    return this.isOAuth ? getProviderForAuthMethod(this._authConfig.authMethod) : ''
  }

  private get activeProvider() {
    return this.isOAuth ? this.lockedProvider : this._authConfig?.provider ?? ''
  }

  private get availableProviders() {
    return getProviderIds()
  }

  private get availableModels() {
    return safeGetModels(this.activeProvider)
  }

  private async update(partial: Partial<AgentAuthConfig>) {
    this._authConfig = normalizeAuthConfig({ ...this._authConfig, ...partial })
    await saveAuthConfig(this._authConfig)
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: this._authConfig,
      bubbles: true,
      composed: true,
    }))
  }

  private async handleAuthMethodChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value as AuthMethod
    const providerOverride = getProviderForAuthMethod(value)
    const partial: Partial<AgentAuthConfig> = { authMethod: value }
    if (providerOverride) {
      partial.provider = providerOverride
      partial.modelId = getModelIdForProvider(providerOverride, this._authConfig.modelId)
    }
    await this.update(partial)
    this.oauthStatus = ''
    this.oauthError = ''
    this.queueRender()
  }

  private async handleSaveApiKey() {
    const key = this.apiKeyInput.trim()
    if (!key) return
    await this.update({ apiKey: key })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private async handleOAuthLogin() {
    this.isLoggingIn = true
    this.oauthError = ''
    this.oauthStatus = 'Starting login...'
    this.oauthAuthUrl = ''
    this.oauthCodeInput = ''
    this.awaitingCode = false
    this.queueRender()

    try {
      const creds = await performOAuthLogin(this._authConfig.authMethod, {
        onAuth: (info) => {
          this.oauthAuthUrl = info.url
          this.oauthInstructions = info.instructions ?? ''
          this.oauthStatus = 'Waiting for authorization...'
          const ipc = window.ipc
          if (ipc) {
            ipc.dialog.openExternal(info.url).catch((err) => {
              console.warn('[agent_settings] Failed to open external browser, falling back to window.open', err)
              window.open(info.url, '_blank', 'noopener')
            })
          } else {
            window.open(info.url, '_blank', 'noopener')
          }
          this.queueRender()
        },
        onPrompt: (prompt) => {
          this.oauthStatus = prompt.message || 'Enter the code:'
          this.awaitingCode = true
          this.queueRender()
          return new Promise<string>((resolve) => {
            this.resolveCodePromise = resolve
          })
        },
        onProgress: (msg) => {
          this.oauthStatus = msg
          this.queueRender()
        },
      })

      const updatedCreds = { ...this._authConfig.oauthCredentials, [this._authConfig.authMethod]: creds }
      await this.update({ oauthCredentials: updatedCreds })
      this.oauthStatus = 'Connected'
      this.awaitingCode = false
      this.oauthAuthUrl = ''
      this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
    } catch (err) {
      this.oauthError = err instanceof Error ? err.message : String(err)
      this.oauthStatus = ''
    } finally {
      this.isLoggingIn = false
      this.awaitingCode = false
      this.resolveCodePromise = null
      this.queueRender()
    }
  }

  private handleSubmitCode() {
    if (this.resolveCodePromise && this.oauthCodeInput.trim()) {
      this.resolveCodePromise(this.oauthCodeInput.trim())
      this.resolveCodePromise = null
      this.awaitingCode = false
      this.oauthCodeInput = ''
      this.oauthStatus = 'Verifying...'
      this.queueRender()
    }
  }

  private async handleLogout() {
    this._authConfig = await logoutOAuth(this._authConfig)
    this.oauthStatus = ''
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: this._authConfig,
      bubbles: true,
      composed: true,
    }))
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
    this.queueRender()
  }

  private async handleProviderChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    const models = safeGetModels(value)
    const firstModelId = models.length > 0 ? models[0].id : ''
    await this.update({ provider: value, modelId: firstModelId })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
    this.queueRender()
  }

  private async handleModelChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    await this.update({ modelId: value })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private async handleThinkingChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value
    await this.update({ thinkingLevel: value })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private esc(str: string): string {
    const d = document.createElement('div')
    d.textContent = str
    return d.innerHTML
  }

  private buildOptions(items: { value: string; label: string }[], selected: string): string {
    return items
      .map(i => `<option value="${this.esc(i.value)}"${i.value === selected ? ' selected' : ''}>${this.esc(i.label)}</option>`)
      .join('')
  }

  render() {
    if (!this._authConfig) return

    const config = this._authConfig
    const disabled = this._disabled
    const disabledAttr = disabled ? 'disabled' : ''

    // ── Section 1: Connection ──

    const authMethodOpts = this.buildOptions(
      authMethods.map(m => ({ value: m.id, label: m.label })),
      config.authMethod,
    )

    let credentialHtml = ''

    if (config.authMethod === 'api-key') {
      const saveDisabled = disabled || !this.apiKeyInput.trim() ? 'disabled' : ''
      credentialHtml = `
        <div class="field">
          <span class="field-label">API Key</span>
          <div class="key-row">
            <input
              type="password"
              value="${this.esc(this.apiKeyInput)}"
              placeholder="sk-..."
              ${disabledAttr}
              data-action="api-key-input"
            >
            <button class="btn btn-accent" ${saveDisabled} data-action="save-api-key">Save</button>
          </div>
        </div>`
    } else if (this.connected) {
      credentialHtml = `
        <div class="connected-row">
          <span class="connected-dot"></span>
          <span class="connected-text">Connected</span>
          <button class="btn" style="margin-left:auto;" ${disabledAttr} data-action="logout">Logout</button>
        </div>`
    } else if (this.awaitingCode) {
      if (this.oauthAuthUrl) {
        credentialHtml += `<div class="oauth-link"><a href="${this.esc(this.oauthAuthUrl)}" target="_blank" rel="noopener">${this.esc(this.oauthAuthUrl)}</a></div>`
      }
      if (this.oauthStatus) {
        credentialHtml += `<div class="oauth-status-row">${this.esc(this.oauthStatus)}</div>`
      }
      const submitDisabled = !this.oauthCodeInput.trim() ? 'disabled' : ''
      credentialHtml += `
        <div class="field">
          <span class="field-label">Code</span>
          <div class="key-row">
            <input
              type="text"
              value="${this.esc(this.oauthCodeInput)}"
              placeholder="Paste code here"
              data-action="oauth-code-input"
            >
            <button class="btn btn-accent" ${submitDisabled} data-action="submit-code">Submit</button>
          </div>
        </div>`
    } else {
      const loginDisabled = disabled || this.isLoggingIn ? 'disabled' : ''
      const loginLabel = this.isLoggingIn ? 'Logging in...' : 'Login'
      credentialHtml = `
        <button class="btn btn-accent" style="width:100%;" ${loginDisabled} data-action="oauth-login">${loginLabel}</button>`
      if (this.oauthStatus) {
        credentialHtml += `<div class="oauth-status-row">${this.esc(this.oauthStatus)}</div>`
      }
    }

    if (this.oauthError) {
      credentialHtml += `<div class="oauth-error-row">${this.esc(this.oauthError)}</div>`
    }

    const connectionHtml = `
      <div class="section">
        <div class="section-body">
          <div class="field">
            <span class="field-label">Auth</span>
            <tl-select value="${this.esc(config.authMethod)}" ${disabledAttr} data-action="auth-method-picker">${authMethodOpts}</tl-select>
          </div>
          ${credentialHtml}
        </div>
      </div>`

    // ── Section 2: Model ──

    let modelSectionBody = ''

    if (!this.isOAuth) {
      const providerOpts = this.buildOptions(
        this.availableProviders.map(p => ({ value: p, label: p })),
        config.provider,
      )
      const modelOpts = this.buildOptions(
        this.availableModels.map((m: { id: string; name?: string }) => ({ value: m.id, label: m.name || m.id })),
        config.modelId,
      )
      const thinkingOpts = this.buildOptions(
        thinkingLevels.map(l => ({ value: l, label: l })),
        config.thinkingLevel,
      )

      modelSectionBody = `
        <div class="field-grid">
          <div class="field">
            <span class="field-label">Provider</span>
            <tl-select value="${this.esc(config.provider)}" ${disabledAttr} data-action="provider-picker">${providerOpts}</tl-select>
          </div>
          <div class="field">
            <span class="field-label">Thinking</span>
            <tl-select value="${this.esc(config.thinkingLevel)}" ${disabledAttr} data-action="thinking-picker">${thinkingOpts}</tl-select>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Model</span>
          <tl-select value="${this.esc(config.modelId)}" ${disabledAttr} data-action="model-picker">${modelOpts}</tl-select>
        </div>`
    } else {
      const modelOpts = this.buildOptions(
        this.availableModels.map((m: { id: string; name?: string }) => ({ value: m.id, label: m.name || m.id })),
        config.modelId,
      )
      const thinkingOpts = this.buildOptions(
        thinkingLevels.map(l => ({ value: l, label: l })),
        config.thinkingLevel,
      )

      modelSectionBody = `
        <div class="field-grid">
          <div class="field">
            <span class="field-label">Model</span>
            <tl-select value="${this.esc(config.modelId)}" ${disabledAttr} data-action="model-picker">${modelOpts}</tl-select>
          </div>
          <div class="field">
            <span class="field-label">Thinking</span>
            <tl-select value="${this.esc(config.thinkingLevel)}" ${disabledAttr} data-action="thinking-picker">${thinkingOpts}</tl-select>
          </div>
        </div>`
    }

    const modelHtml = `
      <div class="section">
        <div class="section-body">
          ${modelSectionBody}
        </div>
      </div>`

    this.innerHTML = `
      <style>${STYLES}</style>
      <div class="settings">
        ${connectionHtml}
        ${modelHtml}
      </div>`

    this.attachListeners()
  }

  private attachListeners() {
    const q = (sel: string) => this.querySelector(sel)

    const authPicker = q('[data-action="auth-method-picker"]')
    if (authPicker) {
      authPicker.addEventListener('change', (e) => this.handleAuthMethodChange(e))
    }

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

    const oauthLoginBtn = q('[data-action="oauth-login"]')
    if (oauthLoginBtn) {
      oauthLoginBtn.addEventListener('click', () => this.handleOAuthLogin())
    }

    const oauthCodeInput = q('[data-action="oauth-code-input"]') as HTMLInputElement | null
    if (oauthCodeInput) {
      oauthCodeInput.addEventListener('input', (e: Event) => {
        this.oauthCodeInput = (e.target as HTMLInputElement).value
      })
      oauthCodeInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.handleSubmitCode()
      })
    }

    const submitCodeBtn = q('[data-action="submit-code"]')
    if (submitCodeBtn) {
      submitCodeBtn.addEventListener('click', () => this.handleSubmitCode())
    }

    const logoutBtn = q('[data-action="logout"]')
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this.handleLogout())
    }

    const providerPicker = q('[data-action="provider-picker"]')
    if (providerPicker) {
      providerPicker.addEventListener('change', (e) => this.handleProviderChange(e))
    }

    const modelPicker = q('[data-action="model-picker"]')
    if (modelPicker) {
      modelPicker.addEventListener('change', (e) => this.handleModelChange(e))
    }

    const thinkingPicker = q('[data-action="thinking-picker"]')
    if (thinkingPicker) {
      thinkingPicker.addEventListener('change', (e) => this.handleThinkingChange(e))
    }

  }
}
