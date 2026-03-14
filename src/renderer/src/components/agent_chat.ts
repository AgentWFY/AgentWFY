import type { AgentMessage, RetryInfo } from '../agent/types.js'
import type { AgentAuthConfig } from '../agent/agent_auth.js'
import { loadAuthConfig } from '../agent/agent_auth.js'
import { getSessionManager, reconnectManager } from '../agent/session_manager.js'
import type { AgentSessionManager, SessionListItem } from '../agent/session_manager.js'
import type { AgentWFYAgent } from '../agent/create_agent.js'
import {
  buildDisplayBlocks,
  updateMessagesEl
} from './chat_message_renderer.js'
import { escapeHtml } from './chat_utils.js'
import { renderSessionPanelHtml } from './chat_session_panel.js'

const STYLES = `
  awfy-agent-chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .container {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding: 10px;
    box-sizing: border-box;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .messages * { overflow-anchor: none; }
  .messages #anchor { overflow-anchor: auto; height: 1px; }
  .block {
    margin-bottom: 8px;
    user-select: text;
    word-break: break-word;
  }
  .block p { margin: 0.4em 0; }
  .block p:last-child { margin-bottom: 0; }
  .block p:first-child { margin-top: 0; }

  /* Inline code */
  .block code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--color-code-bg);
    word-break: break-all;
  }

  /* Code blocks */
  .block pre {
    margin: 6px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-code-bg);
    overflow-x: auto;
    line-height: 1.45;
  }
  .block pre code {
    padding: 0;
    background: none;
    font-size: 12px;
    white-space: pre;
    word-break: normal;
  }

  /* Headings */
  .block h1, .block h2, .block h3,
  .block h4, .block h5, .block h6 {
    margin: 0.6em 0 0.3em;
    line-height: 1.3;
    color: var(--color-text4);
  }
  .block h1 { font-size: 1.3em; }
  .block h2 { font-size: 1.15em; }
  .block h3 { font-size: 1.05em; }
  .block h4, .block h5, .block h6 { font-size: 1em; }
  .block h1:first-child, .block h2:first-child, .block h3:first-child { margin-top: 0; }

  /* Lists */
  .block ul, .block ol {
    margin: 0.3em 0;
    padding-left: 1.5em;
  }
  .block li { margin: 2px 0; }
  .block li > ul, .block li > ol { margin: 2px 0; }
  .block li input[type="checkbox"] {
    margin: 0 4px 0 0;
    vertical-align: middle;
    pointer-events: none;
  }

  /* Blockquotes */
  .block blockquote {
    margin: 0.4em 0;
    padding: 2px 0 2px 10px;
    border-left: 3px solid var(--color-divider);
    color: var(--color-text1);
  }
  .block blockquote p:first-child { margin-top: 0; }
  .block blockquote p:last-child { margin-bottom: 0; }

  /* Tables */
  .block table {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 12px;
    width: 100%;
    display: block;
    overflow-x: auto;
  }
  .block th, .block td {
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    text-align: left;
  }
  .block th {
    background: var(--color-bg3);
    font-weight: 600;
    color: var(--color-text4);
    white-space: nowrap;
  }
  .block tr:nth-child(even) td {
    background: var(--color-bg2);
  }

  /* Horizontal rule */
  .block hr {
    border: none;
    border-top: 1px solid var(--color-divider);
    margin: 0.6em 0;
  }

  /* Links */
  .block a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .block a:hover {
    text-decoration: underline;
  }

  /* Images */
  .block img {
    max-width: 100%;
    border-radius: var(--radius-sm);
    margin: 4px 0;
  }

  /* Strikethrough */
  .block del {
    color: var(--color-text2);
  }
  .block-user {
    background: var(--color-bg3);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
  }
  .assistant-text { padding: 2px 0; }
  .tools-group {
    margin-top: 2px;
  }
  .tool-header {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 1px 0;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    color: var(--color-text2);
  }
  .tool-header:hover { color: var(--color-text3); }
  .tool-header.open .tool-description {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .tool-description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .tool-error-badge {
    font-size: 10px;
    color: var(--color-red-fg);
    flex-shrink: 0;
  }
  .tool-body {
    padding: 4px 0 4px 0;
    font-size: 11px;
  }
  .tool-body pre {
    margin: 0;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow: auto;
    background: var(--color-bg3);
    border-radius: var(--radius-sm);
    color: var(--color-text3);
  }
  .tool-body pre + pre { margin-top: 4px; }
  .tool-body pre.tool-result-error { color: var(--color-red-fg); }
  .tool-body img {
    max-width: 100%;
    border-radius: var(--radius-sm);
    margin-top: 4px;
  }
  .block-custom {
    font-size: 12px;
    color: var(--color-text2);
    padding: 2px 0;
  }
  .block-compaction {
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
  }
  .compaction-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text2);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .compaction-meta {
    font-size: 11px;
    color: var(--color-text2);
    margin-bottom: 6px;
  }
  .input-area {
    margin-top: 10px;
    flex-shrink: 0;
  }
  .input-container {
    position: relative;
    border: 1px solid var(--color-input-border);
    border-radius: var(--radius-md);
    background: var(--color-input-bg);
    transition: border-color var(--transition-fast);
  }
  .input-container:focus-within {
    border-color: var(--color-focus-border);
  }
  .input-container textarea {
    display: block;
    width: 100%;
    resize: none;
    min-height: 36px;
    max-height: 120px;
    line-height: 1.4;
    overflow-y: auto;
    border: none;
    background: transparent;
    padding: 8px 40px 8px 10px;
    outline: none;
    box-sizing: border-box;
  }
  .stop-btn {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-text3);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--color-bg1);
    padding: 0;
    transition: background var(--transition-fast);
  }
  .stop-btn:hover {
    background: var(--color-red-fg);
  }
  .tools-row {
    margin-top: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .error-banner {
    color: var(--color-red-fg);
    padding: 6px 10px;
    margin: 6px 0;
    background: var(--color-red-bg);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .initializing {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text2);
  }
  .thinking-dots {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 2px;
  }
  .thinking-dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    animation: thinking 1.4s ease-in-out infinite;
  }
  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes thinking {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }
  .retry-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 2px;
    font-size: 12px;
    color: var(--color-text2);
  }
  .retry-indicator span.retry-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    animation: thinking 1.4s ease-in-out infinite;
  }
  .model-info {
    font-size: 11px;
    color: var(--color-text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tools-row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .popup-panel {
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 300px;
    overflow-y: auto;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
    margin-top: 4px;
    flex-shrink: 0;
  }
  .settings-panel {
    max-height: 400px;
    padding: 0 10px;
  }
  .setup-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    max-width: 360px;
    margin: 0 auto;
  }
  .setup-container h3 { margin-bottom: 12px; }
  .gear-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    color: var(--color-text2);
    font-size: 16px;
    line-height: 1;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .gear-btn:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .gear-btn.active { color: var(--color-accent); }
  .gear-btn.active svg { fill: currentColor; }
  .session-running-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4caf50;
    flex-shrink: 0;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .session-panel { }
  .session-panel-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text3);
  }
  .session-panel-item:hover { background: var(--color-item-hover); }
  .session-panel-item.active {
    background: var(--color-item-hover);
    font-weight: 600;
  }
  .session-panel-item-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .session-panel-item-date {
    font-size: 11px;
    color: var(--color-text2);
    flex-shrink: 0;
  }
`

export class TlAgentChat extends HTMLElement {
  private manager: AgentSessionManager | null = null
  private managerUnsub: (() => void) | null = null
  private agent: AgentWFYAgent | null = null
  private messages: AgentMessage[] = []
  private isStreaming = false
  private error: string | null = null
  private inputValue = ''
  private activePanel: 'settings' | 'sessions' | null = null
  private isInitializing = true
  private authConfig: AgentAuthConfig | null = null
  private notifyOnFinish = false
  private sessionListItems: SessionListItem[] = []
  private messagesEl: HTMLElement | null = null
  private openToolSet = new Set<string>()
  private containerEl!: HTMLDivElement
  private styleEl!: HTMLStyleElement
  private userScrolledUp = false
  private retryInfo: RetryInfo | null = null
  private _renderMode: 'initializing' | 'setup' | 'chat' | null = null
  private _textarea: HTMLTextAreaElement | null = null
  private _errorBanner: HTMLElement | null = null
  private _sessionPanel: HTMLElement | null = null
  private _newSessionBtn: HTMLElement | null = null
  private _notifyBtn: HTMLElement | null = null
  private _sessionsBtn: HTMLElement | null = null
  private _settingsBtn: HTMLElement | null = null
  private _settingsPanel: HTMLElement | null = null
  private _modelInfo: HTMLElement | null = null
  private _stopBtn: HTMLElement | null = null
  private _sessionPanelDirty = false

  private onSyncSystemPrompt = (e: Event) => {
    const detail = (e as CustomEvent<{ content: string }>).detail
    if (!detail?.content || !this.manager) return
    const prompt = `Update the documentation in the agent.db \`docs\` table based on the following updated documentation.

Steps:
1. Read all current docs: \`SELECT id, name, content, preload FROM docs\`
2. Compare with the content below and decide how to best structure it across docs rows
3. Update existing docs whose content has changed, insert new ones, delete obsolete ones
4. After done, give a short summary of what changed (added, updated, deleted)

Here is the updated documentation:

${detail.content}`
    this.manager.createSession({ prompt }).catch((err) => {
      this.error = err instanceof Error ? err.message : String(err)
      this.render()
    })
  }

  connectedCallback() {
    this.style.display = 'flex'
    this.style.flexDirection = 'column'
    this.style.flex = '1 1 auto'
    this.style.height = '100%'
    this.style.minHeight = '0'

    this.styleEl = document.createElement('style')
    this.styleEl.textContent = STYLES
    this.appendChild(this.styleEl)

    this.containerEl = document.createElement('div')
    this.containerEl.style.display = 'flex'
    this.containerEl.style.flexDirection = 'column'
    this.containerEl.style.flex = '1 1 auto'
    this.containerEl.style.minHeight = '0'
    this.appendChild(this.containerEl)

    this.render()
    this.init()

    window.addEventListener('agentwfy:sync-system-prompt', this.onSyncSystemPrompt)
  }

  disconnectedCallback() {
    window.removeEventListener('agentwfy:sync-system-prompt', this.onSyncSystemPrompt)
    this.managerUnsub?.()
    this.managerUnsub = null
    this.manager = null
    this.agent = null
    this.messages = []
    this.isStreaming = false
    this.sessionListItems = []
    this.clearChatRefs()
    this._renderMode = null
  }

  private async init() {
    try {
      this.authConfig = await loadAuthConfig()
      const mgr = getSessionManager()
      if (mgr) {
        this.manager = mgr
        this.managerUnsub = mgr.subscribe(() => this.refreshState())
        this.refreshState()
      } else {
        this.activePanel = 'settings'
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.isInitializing = false
      this.render()
    }
  }

  private refreshState() {
    if (!this.manager) {
      this.agent = null
      this.messages = []
      this.isStreaming = false
      this.render()
      return
    }
    const session = this.manager.activeSession
    this.agent = session?.agent ?? null
    this.notifyOnFinish = session?.notifyOnFinish ?? false
    if (this.agent) {
      this.messages = this.agent.messages
      this.isStreaming = this.agent.isStreaming
      this.retryInfo = this.agent.state.retryInfo ?? null
    } else {
      this.messages = []
      this.isStreaming = false
      this.retryInfo = null
    }
    this.render()
  }

  private handleConfigChange(e: Event) {
    const detail = (e as CustomEvent<AgentAuthConfig>).detail
    this.authConfig = detail
    if (this.manager) {
      this.manager.updateAuthConfig(this.authConfig)
    }
  }

  private async handleReconnect() {
    this.error = null
    const keepInlineSettingsOpen = !!this.manager && this.activePanel === 'settings'
    this.isInitializing = true
    this.render()
    try {
      this.managerUnsub?.()
      const mgr = await reconnectManager(this.authConfig!)
      this.manager = mgr
      if (mgr) {
        this.managerUnsub = mgr.subscribe(() => this.refreshState())
        this.refreshState()
        this.activePanel = keepInlineSettingsOpen ? 'settings' : null
      } else {
        this.managerUnsub = null
        this.agent = null
        this.messages = []
        this.isStreaming = false
        this.sessionListItems = []
        this.activePanel = 'settings'
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.isInitializing = false
      this.render()
    }
  }

  private async handleStop() {
    if (!this.agent || !this.isStreaming) return
    try {
      await this.agent.abort()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.render()
    }
  }

  private async handleNewSession() {
    if (!this.manager) return
    this.activePanel = null
    try {
      await this.manager.createSession()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.render()
    }
  }

  private async toggleSessionPanel() {
    if (this.activePanel === 'sessions') {
      this.activePanel = null
      this.render()
      return
    }
    if (!this.manager) return

    this.sessionListItems = await this.manager.getSessionList()
    this.activePanel = 'sessions'
    this._sessionPanelDirty = true
    this.render()
  }

  private handleSessionClick(item: SessionListItem) {
    if (item.isActive) return
    this.activePanel = null
    if (item.sessionId && this.manager) {
      this.manager.switchTo(item.sessionId)
    } else if (item.file && this.manager) {
      this.manager.loadSessionFromDisk(item.file).catch(e => {
        this.error = e instanceof Error ? e.message : String(e)
        this.render()
      })
    }
    this.render()
  }

  private async sendMessage() {
    const text = this.inputValue.trim()
    if (!text || !this.agent) return

    this.inputValue = ''
    if (this._textarea) {
      this._textarea.value = ''
      this._textarea.style.height = 'auto'
    }
    this.userScrolledUp = false
    this.render()

    try {
      if (this.isStreaming) {
        await this.agent.prompt(text, { streamingBehavior: 'followUp' })
      } else {
        await this.agent.prompt(text)
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.render()
    }
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      this.sendMessage()
    } else if (e.key === 'Enter' && e.shiftKey) {
      requestAnimationFrame(() => this.autoResizeTextarea(e.target as HTMLTextAreaElement))
    }
  }

  private handleInput(e: Event) {
    const textarea = e.target as HTMLTextAreaElement
    this.inputValue = textarea.value
    this.autoResizeTextarea(textarea)
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement) {
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }

  private handleMessagesScroll = () => {
    if (!this.messagesEl) return
    const threshold = 50
    const distanceFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight
    this.userScrolledUp = distanceFromBottom > threshold
  }

  private render() {
    if (!this.containerEl) return

    const mode = this.isInitializing ? 'initializing'
      : (!this.agent && !this.manager && this.authConfig) ? 'setup'
      : 'chat'

    if (mode === 'initializing') {
      this.clearChatRefs()
      this.containerEl.innerHTML = `<div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;"><div class="initializing">Initializing agent...</div></div>`
      this._renderMode = 'initializing'
      return
    }

    if (mode === 'setup') {
      this.clearChatRefs()
      this.containerEl.innerHTML = `
        <div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;">
          <div class="setup-container">
            <h3>Agent Settings</h3>
            <awfy-agent-settings id="setup-settings"></awfy-agent-settings>
            ${this.error ? `<div class="error-banner">${escapeHtml(this.error)}</div>` : ''}
          </div>
        </div>`
      this.attachSetupSettingsListeners()
      this._renderMode = 'setup'
      return
    }

    // Chat mode
    if (this._renderMode !== 'chat') {
      this.buildChatLayout()
      this._renderMode = 'chat'
    }
    this.updateChat()
  }

  private clearChatRefs() {
    this.messagesEl = null
    this._textarea = null
    this._errorBanner = null
    this._sessionPanel = null
    this._newSessionBtn = null
    this._notifyBtn = null
    this._sessionsBtn = null
    this._settingsBtn = null
    this._settingsPanel = null
    this._modelInfo = null
    this._stopBtn = null
  }

  private buildChatLayout() {
    this.clearChatRefs()
    this.containerEl.innerHTML = ''

    const container = document.createElement('div')
    container.className = 'container'
    container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;'

    // Messages area
    this.messagesEl = document.createElement('div')
    this.messagesEl.className = 'messages'
    this.messagesEl.style.cssText = 'flex:1;min-height:0;overflow-y:auto;'
    this.messagesEl.addEventListener('scroll', this.handleMessagesScroll)
    this.messagesEl.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement
      const toolHeader = target.closest('.tool-header[data-tool-id]') as HTMLElement | null
      if (toolHeader) {
        e.preventDefault()
        const toolId = toolHeader.dataset.toolId
        if (toolId) {
          if (this.openToolSet.has(toolId)) {
            this.openToolSet.delete(toolId)
          } else {
            this.openToolSet.add(toolId)
          }
          this.render()
        }
      }
    })
    container.appendChild(this.messagesEl)

    // Error banner (hidden by default)
    this._errorBanner = document.createElement('div')
    this._errorBanner.className = 'error-banner'
    this._errorBanner.style.display = 'none'
    container.appendChild(this._errorBanner)

    // Session panel (hidden by default)
    this._sessionPanel = document.createElement('div')
    this._sessionPanel.className = 'popup-panel session-panel'
    this._sessionPanel.style.display = 'none'
    this._sessionPanel.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement
      const newBtn = target.closest('#new-session-btn') as HTMLElement | null
      if (newBtn) {
        e.preventDefault()
        this.handleNewSession()
        return
      }
      const sessionItem = target.closest('.session-panel-item[data-session-idx]') as HTMLElement | null
      if (sessionItem) {
        e.preventDefault()
        const idx = parseInt(sessionItem.dataset.sessionIdx!, 10)
        const item = this.sessionListItems[idx]
        if (item) this.handleSessionClick(item)
      }
    })
    container.appendChild(this._sessionPanel)

    // Settings panel (hidden by default, content lazy-created)
    this._settingsPanel = document.createElement('div')
    this._settingsPanel.className = 'popup-panel settings-panel'
    this._settingsPanel.style.display = 'none'
    container.appendChild(this._settingsPanel)

    // Input area
    const inputArea = document.createElement('div')
    inputArea.className = 'input-area'
    inputArea.style.cssText = 'margin-top:10px;flex-shrink:0;'

    const inputContainer = document.createElement('div')
    inputContainer.className = 'input-container'

    this._textarea = document.createElement('textarea')
    this._textarea.id = 'msg-input'
    this._textarea.rows = 1
    this._textarea.placeholder = 'Type your message here...'
    this._textarea.value = this.inputValue
    this._textarea.addEventListener('keydown', (e) => this.handleKeydown(e))
    this._textarea.addEventListener('input', (e) => this.handleInput(e))
    inputContainer.appendChild(this._textarea)

    this._stopBtn = document.createElement('button')
    this._stopBtn.className = 'stop-btn'
    this._stopBtn.title = 'Stop'
    this._stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="1.5" fill="currentColor"/></svg>'
    this._stopBtn.style.display = 'none'
    this._stopBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.handleStop()
    })
    inputContainer.appendChild(this._stopBtn)

    inputArea.appendChild(inputContainer)

    const toolsRow = document.createElement('div')
    toolsRow.className = 'tools-row'

    this._modelInfo = document.createElement('div')
    this._modelInfo.className = 'model-info'
    toolsRow.appendChild(this._modelInfo)

    const actionsDiv = document.createElement('div')
    actionsDiv.className = 'tools-row-actions'

    // New session button
    this._newSessionBtn = document.createElement('button')
    this._newSessionBtn.className = 'gear-btn'
    this._newSessionBtn.title = 'New session'
    this._newSessionBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>'
    this._newSessionBtn.style.display = 'none'
    this._newSessionBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.handleNewSession()
    })
    actionsDiv.appendChild(this._newSessionBtn)

    // Notify button
    this._notifyBtn = document.createElement('button')
    this._notifyBtn.className = 'gear-btn'
    this._notifyBtn.title = 'Notify when finished'
    this._notifyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5C5.5 1.5 4 3.5 4 5.5c0 3-1.5 4.5-2 5h12c-.5-.5-2-2-2-5 0-2-1.5-4-4-4z"/><path d="M6.5 12.5c.3.6.9 1 1.5 1s1.2-.4 1.5-1"/></svg>'
    this._notifyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (this.manager && this.manager.activeSessionId) {
        this.manager.setNotifyOnFinish(this.manager.activeSessionId, !this.notifyOnFinish)
      }
    })
    actionsDiv.appendChild(this._notifyBtn)

    // Sessions button
    this._sessionsBtn = document.createElement('button')
    this._sessionsBtn.className = 'gear-btn'
    this._sessionsBtn.title = 'Sessions'
    this._sessionsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>'
    this._sessionsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.toggleSessionPanel()
    })
    actionsDiv.appendChild(this._sessionsBtn)

    // Settings button
    this._settingsBtn = document.createElement('button')
    this._settingsBtn.className = 'gear-btn'
    this._settingsBtn.title = 'Settings'
    this._settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    this._settingsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.activePanel = this.activePanel === 'settings' ? null : 'settings'
      this.render()
    })
    actionsDiv.appendChild(this._settingsBtn)

    toolsRow.appendChild(actionsDiv)
    inputArea.appendChild(toolsRow)

    container.appendChild(inputArea)
    this.containerEl.appendChild(container)
  }

  private updateChat() {
    const displayBlocks = buildDisplayBlocks(this.messages)

    // 1. Messages area
    if (this.messagesEl) {
      updateMessagesEl(this.messagesEl, displayBlocks, this.openToolSet, this.isStreaming, this.retryInfo)

      // Auto-scroll
      if (!this.userScrolledUp) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight
      }
    }

    // 2. Stop button
    if (this._stopBtn) {
      this._stopBtn.style.display = this.isStreaming ? '' : 'none'
    }

    // 3. Error banner
    if (this._errorBanner) {
      if (this.error) {
        this._errorBanner.style.display = ''
        this._errorBanner.textContent = this.error
      } else {
        this._errorBanner.style.display = 'none'
      }
    }

    // 4. Button states
    if (this._notifyBtn) {
      this._notifyBtn.classList.toggle('active', this.notifyOnFinish)
    }
    if (this._sessionsBtn) {
      this._sessionsBtn.classList.toggle('active', this.activePanel === 'sessions')
    }
    if (this._settingsBtn) {
      this._settingsBtn.classList.toggle('active', this.activePanel === 'settings')
    }

    // 5. New session button visibility
    if (this._newSessionBtn) {
      this._newSessionBtn.style.display = this.messages.length > 0 ? '' : 'none'
    }

    // 6. Textarea placeholder
    if (this._textarea) {
      const newPlaceholder = this.isStreaming ? 'Send follow-up message...' : 'Type your message here...'
      if (this._textarea.placeholder !== newPlaceholder) {
        this._textarea.placeholder = newPlaceholder
      }
    }

    // 7. Model info
    if (this._modelInfo) {
      this._modelInfo.textContent = this.authConfig?.modelId ?? ''
    }

    // 8. Session panel
    if (this._sessionPanel) {
      if (this.activePanel === 'sessions') {
        this._sessionPanel.style.display = ''
        if (this._sessionPanelDirty) {
          this._sessionPanel.innerHTML = renderSessionPanelHtml(this.sessionListItems)
          this._sessionPanelDirty = false
        }
      } else {
        this._sessionPanel.style.display = 'none'
      }
    }

    // 9. Settings panel
    this.updateSettingsPanel()
  }

  private updateSettingsPanel() {
    if (!this._settingsPanel) return
    if (this.activePanel === 'settings' && this.authConfig) {
      this._settingsPanel.style.display = ''
      let settingsEl = this._settingsPanel.querySelector('awfy-agent-settings') as HTMLElement & { authConfig?: AgentAuthConfig; disabled?: boolean } | null
      if (!settingsEl) {
        settingsEl = document.createElement('awfy-agent-settings') as HTMLElement & { authConfig?: AgentAuthConfig; disabled?: boolean }
        settingsEl.id = 'inline-settings'
        settingsEl.addEventListener('config-change', (e: Event) => this.handleConfigChange(e))
        settingsEl.addEventListener('reconnect', () => this.handleReconnect())
        this._settingsPanel.appendChild(settingsEl)
      }
      settingsEl.authConfig = this.authConfig!
      settingsEl.disabled = this.isStreaming
    } else {
      this._settingsPanel.style.display = 'none'
    }
  }

  private attachSetupSettingsListeners() {
    const settingsEl = this.containerEl.querySelector('#setup-settings') as HTMLElement & { authConfig?: AgentAuthConfig } | null
    if (settingsEl && this.authConfig) {
      settingsEl.authConfig = this.authConfig
      settingsEl.addEventListener('config-change', (e: Event) => this.handleConfigChange(e))
      settingsEl.addEventListener('reconnect', () => this.handleReconnect())
    }
  }
}
