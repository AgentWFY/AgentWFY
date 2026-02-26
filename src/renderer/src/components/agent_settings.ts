import { getModels, getProviders } from '@mariozechner/pi-ai'
import type { ThinkingLevel } from '@mariozechner/pi-agent-core'
import type { AgentAuthConfig, AuthMethod } from 'app/agent/agent_auth'
import {
  saveAuthConfig,
  getAvailableOAuthProviders,
  performOAuthLogin,
  isOAuthConnected,
  getProviderForAuthMethod,
  logoutOAuth,
} from 'app/agent/agent_auth'

const STYLES = `
  .settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px 0;
    font-size: 13px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--spectrum-global-color-gray-700);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .field-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .field-row sp-textfield { flex: 1; }
  .oauth-status {
    font-size: 12px;
    color: var(--spectrum-global-color-gray-600);
    padding: 2px 0;
  }
  .oauth-error {
    font-size: 12px;
    color: var(--spectrum-global-color-red-700);
    padding: 2px 0;
  }
  .oauth-link {
    font-size: 11px;
    color: var(--spectrum-global-color-blue-600);
    word-break: break-all;
  }
  .oauth-link a { color: inherit; }
  .connected-badge {
    font-size: 11px;
    color: var(--spectrum-global-color-green-700);
    font-weight: 600;
  }
  sp-picker { width: 100%; }
`

const oauthProviders = getAvailableOAuthProviders()
const authMethods: { id: AuthMethod; label: string }[] = [
  { id: 'api-key', label: 'API Key' },
  ...oauthProviders.map(p => ({ id: p.id, label: p.name })),
]
const thinkingLevels: ThinkingLevel[] = ['off' as any, 'minimal', 'low', 'medium', 'high', 'xhigh']

function safeGetModels(provider: string) {
  try {
    return getModels(provider as any)
  } catch {
    return []
  }
}

function getModelIdForProvider(provider: string, currentModelId: string): string {
  const models = safeGetModels(provider)
  if (models.some((model: any) => model.id === currentModelId)) {
    return currentModelId
  }
  return models.length > 0 ? models[0].id : ''
}

export class TlAgentSettings extends HTMLElement {
  private _authConfig!: AgentAuthConfig
  private _disabled = false
  private _showTools = true

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
    this._authConfig = val
    this.apiKeyInput = val.apiKey ?? ''
    this.queueRender()
  }

  get disabled(): boolean { return this._disabled }
  set disabled(val: boolean) {
    this._disabled = val
    this.queueRender()
  }

  get showTools(): boolean { return this._showTools }
  set showTools(val: boolean) {
    this._showTools = val
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
    return getProviders() as string[]
  }

  private get availableModels() {
    return safeGetModels(this.activeProvider)
  }

  private async update(partial: Partial<AgentAuthConfig>) {
    this._authConfig = { ...this._authConfig, ...partial }
    await saveAuthConfig(this._authConfig)
    this.dispatchEvent(new CustomEvent('config-change', {
      detail: this._authConfig,
      bubbles: true,
      composed: true,
    }))
  }

  private async handleAuthMethodChange(e: Event) {
    const value = (e.target as any).value as AuthMethod
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
          window.open(info.url, '_blank')
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
    const value = (e.target as any).value
    const models = safeGetModels(value)
    const firstModelId = models.length > 0 ? models[0].id : ''
    await this.update({ provider: value, modelId: firstModelId })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
    this.queueRender()
  }

  private async handleModelChange(e: Event) {
    const value = (e.target as any).value
    await this.update({ modelId: value })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private async handleThinkingChange(e: Event) {
    const value = (e.target as any).value
    await this.update({ thinkingLevel: value })
    this.dispatchEvent(new CustomEvent('reconnect', { bubbles: true, composed: true }))
  }

  private esc(str: string): string {
    const d = document.createElement('div')
    d.textContent = str
    return d.innerHTML
  }

  render() {
    if (!this._authConfig) return

    const config = this._authConfig
    const disabled = this._disabled
    const disabledAttr = disabled ? 'disabled' : ''

    let authSectionHtml = ''

    if (config.authMethod === 'api-key') {
      const saveDisabled = disabled || !this.apiKeyInput.trim() ? 'disabled' : ''
      authSectionHtml = `
        <div class="field">
          <div class="field-row">
            <sp-textfield
              value="${this.esc(this.apiKeyInput)}"
              placeholder="Enter your API key"
              type="password"
              ${disabledAttr}
              data-action="api-key-input"
            ></sp-textfield>
            <sp-button
              variant="primary"
              size="s"
              ${saveDisabled}
              data-action="save-api-key"
            >Save</sp-button>
          </div>
        </div>`
    } else {
      if (this.connected) {
        authSectionHtml = `
          <div class="field">
            <div class="field-row">
              <span class="connected-badge">Connected</span>
              <sp-button
                variant="secondary"
                size="s"
                ${disabledAttr}
                data-action="logout"
              >Logout</sp-button>
            </div>
          </div>`
      } else if (this.awaitingCode) {
        let linkHtml = ''
        if (this.oauthAuthUrl) {
          linkHtml = `
            <div class="oauth-link">
              <a href="${this.esc(this.oauthAuthUrl)}" target="_blank" rel="noopener">${this.esc(this.oauthAuthUrl)}</a>
            </div>`
        }
        let statusHtml = ''
        if (this.oauthStatus) {
          statusHtml = `<div class="oauth-status">${this.esc(this.oauthStatus)}</div>`
        }
        const submitDisabled = !this.oauthCodeInput.trim() ? 'disabled' : ''
        authSectionHtml = `
          <div class="field">
            ${linkHtml}
            ${statusHtml}
            <div class="field-row">
              <sp-textfield
                value="${this.esc(this.oauthCodeInput)}"
                placeholder="Paste code here"
                data-action="oauth-code-input"
              ></sp-textfield>
              <sp-button
                variant="primary"
                size="s"
                ${submitDisabled}
                data-action="submit-code"
              >Submit</sp-button>
            </div>
          </div>`
      } else {
        const loginDisabled = disabled || this.isLoggingIn ? 'disabled' : ''
        const loginLabel = this.isLoggingIn ? 'Logging in...' : 'Login'
        let statusHtml = ''
        if (this.oauthStatus) {
          statusHtml = `<div class="oauth-status">${this.esc(this.oauthStatus)}</div>`
        }
        authSectionHtml = `
          <div class="field">
            <sp-button
              variant="primary"
              size="s"
              ${loginDisabled}
              data-action="oauth-login"
            >${loginLabel}</sp-button>
            ${statusHtml}
          </div>`
      }

      if (this.oauthError) {
        authSectionHtml += `<div class="oauth-error">${this.esc(this.oauthError)}</div>`
      }
    }

    // Provider picker (only for api-key method)
    let providerHtml = ''
    if (!this.isOAuth) {
      const providerItems = this.availableProviders
        .map(prov => `<sp-menu-item value="${this.esc(prov)}">${this.esc(prov)}</sp-menu-item>`)
        .join('')
      providerHtml = `
        <div class="field">
          <span class="field-label">Provider</span>
          <sp-picker
            value="${this.esc(config.provider)}"
            ${disabledAttr}
            data-action="provider-picker"
          >${providerItems}</sp-picker>
        </div>`
    }

    // Model picker
    const modelItems = this.availableModels
      .map((m: any) => `<sp-menu-item value="${this.esc(m.id)}">${this.esc(m.name || m.id)}</sp-menu-item>`)
      .join('')
    const modelHtml = `
      <div class="field">
        <span class="field-label">Model</span>
        <sp-picker
          value="${this.esc(config.modelId)}"
          ${disabledAttr}
          data-action="model-picker"
        >${modelItems}</sp-picker>
      </div>`

    // Thinking picker
    const thinkingItems = thinkingLevels
      .map(level => `<sp-menu-item value="${level}">${level}</sp-menu-item>`)
      .join('')
    const thinkingHtml = `
      <div class="field">
        <span class="field-label">Thinking</span>
        <sp-picker
          value="${this.esc(config.thinkingLevel)}"
          ${disabledAttr}
          data-action="thinking-picker"
        >${thinkingItems}</sp-picker>
      </div>`

    // Show tools toggle
    const checkedAttr = this._showTools ? 'checked' : ''
    const toolsHtml = `
      <div class="field">
        <span class="field-label">Display</span>
        <sp-switch
          ${checkedAttr}
          data-action="tools-toggle"
        >Show tool calls</sp-switch>
      </div>`

    // Auth method picker
    const authMethodItems = authMethods
      .map(m => `<sp-menu-item value="${this.esc(m.id)}">${this.esc(m.label)}</sp-menu-item>`)
      .join('')

    this.innerHTML = `
      <style>${STYLES}</style>
      <div class="settings">
        <div class="field">
          <span class="field-label">Authentication</span>
          <sp-picker
            value="${this.esc(config.authMethod)}"
            ${disabledAttr}
            data-action="auth-method-picker"
          >${authMethodItems}</sp-picker>
        </div>
        ${authSectionHtml}
        ${providerHtml}
        ${modelHtml}
        ${thinkingHtml}
        ${toolsHtml}
      </div>`

    this.attachListeners()
  }

  private attachListeners() {
    const q = (sel: string) => this.querySelector(sel)

    const authPicker = q('[data-action="auth-method-picker"]')
    if (authPicker) {
      authPicker.addEventListener('change', (e) => this.handleAuthMethodChange(e))
    }

    const apiKeyInput = q('[data-action="api-key-input"]') as any
    if (apiKeyInput) {
      apiKeyInput.addEventListener('change', (e: any) => {
        this.apiKeyInput = e.currentTarget.value
        this.queueRender()
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

    const oauthCodeInput = q('[data-action="oauth-code-input"]') as any
    if (oauthCodeInput) {
      oauthCodeInput.addEventListener('change', (e: any) => {
        this.oauthCodeInput = e.currentTarget.value
        this.queueRender()
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

    const toolsToggle = q('[data-action="tools-toggle"]')
    if (toolsToggle) {
      toolsToggle.addEventListener('change', () => {
        this.dispatchEvent(new CustomEvent('tools-toggle', {
          detail: !this._showTools,
          bubbles: true,
          composed: true,
        }))
      })
    }
  }
}
