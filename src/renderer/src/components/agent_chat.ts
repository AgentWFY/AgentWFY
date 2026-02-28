import { marked } from 'marked'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { AgentAuthConfig } from 'app/agent/agent_auth'
import { loadAuthConfig, hasValidAuth } from 'app/agent/agent_auth'
import { AgentSessionManager } from 'app/agent/session_manager'
import type { SessionHistoryItem } from 'app/agent/session_manager'
import {
  COMPACTION_SUMMARY_CUSTOM_TYPE,
  type AgentWFYAgent
} from 'app/agent/create_agent'
import type { TlJson } from 'app/components/json_view'

interface ToolPair {
  name: string
  id: string
  arguments: any
  result: any | null
  isError: boolean
}

interface DisplayBlock {
  type: 'user' | 'assistant' | 'custom' | 'compaction'
  text: string
  tools: ToolPair[]
  compactionBeforeCount?: number
  raw: any
}

type SessionListItem = {
  label: string
  updatedAt: number
  isActive: boolean
  isStreaming: boolean
  file: string | null
  sessionId: string | null
}

const STYLES = `
  tl-agent-chat {
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
  .block pre { white-space: pre-wrap; word-break: break-all; }
  .block code { white-space: pre-wrap; word-break: break-all; }
  .block p { margin: 0.4em 0; }
  .block p:last-child { margin-bottom: 0; }
  .block p:first-child { margin-top: 0; }
  .block-user {
    background: var(--color-bg3);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
  }
  .assistant-text { padding: 2px 0; }
  .tools-group {
    margin-top: 2px;
    font-size: 12px;
    color: var(--color-text2);
  }
  .tool-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 0;
    cursor: pointer;
    user-select: none;
  }
  .tool-line:hover { color: var(--color-text4); }
  .tool-line-name {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .tool-line-name::before {
    content: '>';
    margin-right: 4px;
    opacity: 0.5;
  }
  .tool-line-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .tool-error-label {
    color: var(--color-red-fg);
    font-size: 11px;
  }
  .tool-detail {
    padding: 2px 0 2px 16px;
    font-size: 11px;
  }
  .tool-detail pre {
    margin: 0;
    max-height: 200px;
    overflow: auto;
    color: var(--color-text1);
  }
  .tool-detail img {
    max-width: 100%;
    border-radius: var(--radius-sm);
    margin: 4px 0;
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
  .input-area textarea {
    resize: none;
    min-height: 36px;
    max-height: 120px;
    line-height: 1.4;
    overflow-y: auto;
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
  .streaming-indicator {
    color: var(--color-text2);
    font-size: 12px;
    padding: 2px 0;
  }
  .stop-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-red-fg);
    font-size: 12px;
    padding: 0 4px;
    text-decoration: underline;
  }
  .stop-btn:hover { opacity: 0.8; }
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
  .settings-panel {
    border-top: 1px solid var(--color-border);
    padding-top: 8px;
    margin-top: 4px;
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
  }
  .gear-btn:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .gear-btn.active { color: var(--color-accent); }
  .session-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
    color: var(--color-text2);
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
  }
  .session-indicator:hover { color: var(--color-text4); }
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
  .session-panel {
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 300px;
    overflow-y: auto;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
    margin-top: 4px;
    flex-shrink: 0;
  }
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
  private showTools = true
  private showSettings = false
  private isInitializing = true
  private authConfig: AgentAuthConfig | null = null
  private showSessionPanel = false
  private backgroundStreamingCount = 0
  private sessionListItems: SessionListItem[] = []
  private messagesEl: HTMLElement | null = null
  private openToolSet = new Set<string>()
  private containerEl!: HTMLDivElement
  private styleEl!: HTMLStyleElement
  private userScrolledUp = false

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
  }

  disconnectedCallback() {
    this.disposeManager()
  }

  private async init() {
    try {
      this.authConfig = await loadAuthConfig()
      if (hasValidAuth(this.authConfig)) {
        await this.initManager(this.authConfig)
      } else {
        this.showSettings = true
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
      this.backgroundStreamingCount = 0
      this.agent = null
      this.messages = []
      this.isStreaming = false
      this.render()
      return
    }
    this.backgroundStreamingCount = this.manager.backgroundStreamingSessions.length
    const session = this.manager.activeSession
    this.agent = session?.agent ?? null
    if (this.agent) {
      this.messages = this.agent.messages
      this.isStreaming = this.agent.isStreaming
    } else {
      this.messages = []
      this.isStreaming = false
    }
    this.render()
  }

  private async initManager(config: AgentAuthConfig) {
    this.disposeManager()

    this.manager = new AgentSessionManager(config)
    this.manager.startListening()

    this.managerUnsub = this.manager.subscribe(() => {
      this.refreshState()
    })

    try {
      await this.manager.createSession()
    } catch (e) {
      this.disposeManager()
      throw e
    }
    this.refreshState()
  }

  private disposeManager() {
    if (this.managerUnsub) {
      this.managerUnsub()
      this.managerUnsub = null
    }
    if (this.manager) {
      this.manager.disposeAll().catch((err) => {
        console.error('[agent_chat] dispose manager failed', err)
      })
      this.manager = null
    }
    this.agent = null
    this.messages = []
    this.isStreaming = false
    this.backgroundStreamingCount = 0
    this.sessionListItems = []
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
    if (!this.authConfig || !hasValidAuth(this.authConfig)) {
      this.disposeManager()
      this.showSettings = true
      this.isInitializing = false
      this.render()
      return
    }
    // Keep inline settings open when reconnecting from an already-active chat.
    const keepInlineSettingsOpen = !!this.manager && this.showSettings
    this.isInitializing = true
    this.render()
    try {
      await this.initManager(this.authConfig)
      this.showSettings = keepInlineSettingsOpen
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
    this.showSessionPanel = false
    try {
      await this.manager.createSession()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.render()
    }
  }

  private async toggleSessionPanel() {
    if (this.showSessionPanel) {
      this.showSessionPanel = false
      this.render()
      return
    }
    if (!this.manager) return

    let history: SessionHistoryItem[] = []
    try {
      history = await this.manager.listSessionHistory()
    } catch {
      history = []
    }

    const activeFile = this.manager.activeSession?.agent.sessionFile
    const bgSessions = this.manager.backgroundStreamingSessions
    const bgFileMap = new Map<string, string>()
    for (const [id, entry] of bgSessions) {
      if (entry.agent.sessionFile) bgFileMap.set(entry.agent.sessionFile, id)
    }

    const items: SessionListItem[] = []

    for (const h of history) {
      const bgId = bgFileMap.get(h.file)
      const isAct = h.file === activeFile
      items.push({
        label: h.firstUserMessage,
        updatedAt: h.updatedAt,
        isActive: isAct,
        isStreaming: isAct ? this.isStreaming : !!bgId,
        file: isAct ? null : (bgId ? null : h.file),
        sessionId: bgId ?? null,
      })
    }

    // Background sessions not yet saved to disk
    for (const [id, entry] of bgSessions) {
      const file = entry.agent.sessionFile
      if (!file || !history.some(h => h.file === file)) {
        items.push({
          label: entry.label || 'New session',
          updatedAt: Date.now(),
          isActive: false,
          isStreaming: true,
          file: null,
          sessionId: id,
        })
      }
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt)
    this.sessionListItems = items
    this.showSessionPanel = true
    this.render()
  }

  private handleSessionClick(item: SessionListItem) {
    if (item.isActive) return
    this.showSessionPanel = false
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

  private toggleTool(id: string) {
    if (this.openToolSet.has(id)) {
      this.openToolSet.delete(id)
    } else {
      this.openToolSet.add(id)
    }
    this.render()
  }

  private isToolOpen(id: string): boolean {
    return this.openToolSet.has(id)
  }

  private getTextFromContent(content: any): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block?.type === 'text')
        .map((block: any) => block.text)
        .join('')
    }
    return ''
  }

  private getToolCalls(content: any): any[] {
    if (!Array.isArray(content)) return []
    return content.filter((block: any) => block?.type === 'toolCall')
  }

  private buildDisplayBlocks(msgs: AgentMessage[]): DisplayBlock[] {
    const blocks: DisplayBlock[] = []
    let i = 0
    while (i < msgs.length) {
      const msg = msgs[i] as any
      if (msg.role === 'user') {
        blocks.push({ type: 'user', text: this.getTextFromContent(msg.content), tools: [], raw: msg })
        i++
      } else if (msg.role === 'assistant') {
        const text = this.getTextFromContent(msg.content)
        const toolCalls = this.getToolCalls(msg.content)
        const tools: ToolPair[] = []
        let j = i + 1
        for (const tc of toolCalls) {
          const pair: ToolPair = { name: tc.name, id: tc.id, arguments: tc.arguments, result: null, isError: false }
          if (j < msgs.length && (msgs[j] as any).role === 'toolResult' && (msgs[j] as any).toolCallId === tc.id) {
            const tr = msgs[j] as any
            pair.result = tr.content
            pair.isError = tr.isError
            j++
          }
          tools.push(pair)
        }
        blocks.push({ type: 'assistant', text, tools, raw: msg })
        i = j
      } else if (msg.role === 'toolResult') {
        i++
      } else if (msg.role === 'custom') {
        if (msg.customType === COMPACTION_SUMMARY_CUSTOM_TYPE) {
          const details = msg.details && typeof msg.details === 'object' ? msg.details as Record<string, unknown> : null
          const beforeCount = typeof details?.beforeCount === 'number' ? details.beforeCount : undefined
          blocks.push({
            type: 'compaction',
            text: this.getTextFromContent(msg.content),
            tools: [],
            compactionBeforeCount: beforeCount,
            raw: msg
          })
        } else {
          blocks.push({ type: 'custom', text: '', tools: [], raw: msg })
        }
        i++
      } else {
        i++
      }
    }
    return blocks
  }

  private renderMarkdown(text: string): string {
    return marked(text) as string
  }

  private extractImagesFromResult(result: any): { images: Array<{ data: string; mimeType: string }>; filteredResult: any } {
    const images: Array<{ data: string; mimeType: string }> = []
    if (!Array.isArray(result)) return { images, filteredResult: result }

    const filtered = result.filter((item: any) => {
      if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        images.push({ data: item.data, mimeType: item.mimeType })
        return false
      }
      return true
    })

    return { images, filteredResult: filtered }
  }

  private summarizeArgs(args: any): string {
    if (!args || typeof args !== 'object') return ''
    const keys = Object.keys(args)
    if (keys.length === 0) return ''
    const parts = keys.slice(0, 3).map(k => {
      const v = args[k]
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return s.length > 40 ? s.slice(0, 40) + '...' : s
    })
    if (keys.length > 3) parts.push('...')
    return parts.join(', ')
  }

  private formatDate(ts: number): string {
    const d = new Date(ts)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${month}/${day} ${hours}:${mins}`
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  private handleMessagesScroll = () => {
    if (!this.messagesEl) return
    const threshold = 50
    const distanceFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight
    this.userScrolledUp = distanceFromBottom > threshold
  }

  private render() {
    if (!this.containerEl) return

    const displayBlocks = this.buildDisplayBlocks(this.messages)

    if (this.isInitializing) {
      this.containerEl.innerHTML = `<div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;"><div class="initializing">Initializing agent...</div></div>`
      return
    }

    if (!this.agent && !this.manager && this.authConfig) {
      this.containerEl.innerHTML = `
        <div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;">
          <div class="setup-container">
            <h3>Agent Settings</h3>
            <tl-agent-settings id="setup-settings"></tl-agent-settings>
            ${this.error ? `<div class="error-banner">${this.escapeHtml(this.error)}</div>` : ''}
          </div>
        </div>`
      this.attachSetupSettingsListeners()
      return
    }

    let html = '<div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:10px;box-sizing:border-box;">'

    // Session indicator
    if (this.backgroundStreamingCount > 0) {
      html += `<div class="session-indicator" id="session-indicator">
        <span class="session-running-dot"></span>
        <span>${this.backgroundStreamingCount} running</span>
      </div>`
    }

    // Messages
    html += '<div class="messages" id="messages-el" style="flex:1;min-height:0;overflow-y:auto;">'
    for (const block of displayBlocks) {
      if (block.type === 'user') {
        html += `<div class="block block-user">${this.renderMarkdown(block.text)}</div>`
      } else if (block.type === 'assistant') {
        if (this.showTools || block.text.trim()) {
          html += '<div class="block block-assistant">'
          if (block.text) {
            html += `<div class="assistant-text">${this.renderMarkdown(block.text)}</div>`
          }
          if (this.showTools && block.tools.length > 0) {
            html += '<div class="tools-group">'
            for (const tool of block.tools) {
              html += `<div class="tool-line" data-tool-id="${this.escapeHtml(tool.id)}">
                <span class="tool-line-name">${this.escapeHtml(tool.name)}</span>
                <span class="tool-line-summary">${this.escapeHtml(this.summarizeArgs(tool.arguments))}</span>
                ${tool.isError ? '<span class="tool-error-label">error</span>' : ''}
              </div>`
              if (this.isToolOpen(tool.id)) {
                const { images, filteredResult } = this.extractImagesFromResult(tool.result)
                html += `<div class="tool-detail">
                  <pre>${this.escapeHtml(JSON.stringify({ args: tool.arguments, result: filteredResult }, null, 2))}</pre>
                  ${images.map(img => `<img src="data:${this.escapeHtml(img.mimeType)};base64,${img.data}">`).join('')}
                </div>`
              }
            }
            html += '</div>'
          }
          html += '</div>'
        }
      } else if (block.type === 'compaction') {
        html += '<div class="block block-compaction">'
        html += '<div class="compaction-label">[compaction]</div>'
        if (typeof block.compactionBeforeCount === 'number') {
          html += `<div class="compaction-meta">Compacted ${block.compactionBeforeCount.toLocaleString()} messages</div>`
        }
        if (block.text.trim()) {
          html += `<div class="assistant-text">${this.renderMarkdown(block.text)}</div>`
        }
        html += '</div>'
      } else if (block.type === 'custom') {
        html += `<div class="block block-custom"><tl-json data-block-idx="${displayBlocks.indexOf(block)}"></tl-json></div>`
      }
    }
    if (this.isStreaming) {
      html += `<div class="streaming-indicator">
        Agent is responding... <button class="stop-btn" id="stop-btn">Stop</button>
      </div>`
    }
    html += '<div id="anchor"></div>'
    html += '</div>'

    // Error
    if (this.error) {
      html += `<div class="error-banner">${this.escapeHtml(this.error)}</div>`
    }

    // Session panel
    if (this.showSessionPanel) {
      html += '<div class="session-panel">'
      html += `<div class="session-panel-item${!this.sessionListItems.some(i => i.isActive) ? ' active' : ''}" id="new-session-btn">
        <span class="session-panel-item-label">New session</span>
      </div>`
      for (let idx = 0; idx < this.sessionListItems.length; idx++) {
        const item = this.sessionListItems[idx]
        html += `<div class="session-panel-item${item.isActive ? ' active' : ''}" data-session-idx="${idx}">
          ${item.isStreaming ? '<span class="session-running-dot"></span>' : ''}
          <span class="session-panel-item-label">${this.escapeHtml(item.label)}</span>
          <span class="session-panel-item-date">${this.formatDate(item.updatedAt)}</span>
        </div>`
      }
      html += '</div>'
    }

    // Input area
    html += '<div class="input-area" style="margin-top:10px;flex-shrink:0;">'
    html += `<textarea
      id="msg-input"
      rows="1"
      placeholder="${this.isStreaming ? 'Send follow-up message...' : 'Type your message here...'}"
      ${this.isInitializing ? 'disabled' : ''}
    ></textarea>`
    html += '<div class="tools-row">'
    html += `<div class="model-info">${this.escapeHtml(this.authConfig?.modelId ?? '')}</div>`
    html += '<div class="tools-row-actions">'
    if (this.messages.length > 0) {
      html += `<button class="gear-btn" title="New session" id="new-session-action-btn">+</button>`
    }
    html += `<button class="gear-btn${this.showSessionPanel ? ' active' : ''}" title="Sessions" id="sessions-btn">&#9776;</button>`
    html += `<button class="gear-btn${this.showSettings ? ' active' : ''}" title="Settings" id="settings-btn">&#9881;</button>`
    html += '</div></div>'

    if (this.showSettings && this.authConfig) {
      html += `<div class="settings-panel">
        <tl-agent-settings id="inline-settings"></tl-agent-settings>
      </div>`
    }

    html += '</div>'
    html += '</div>'

    this.containerEl.innerHTML = html

    // Set up tl-json elements with data
    const customBlocks = displayBlocks.filter(b => b.type === 'custom')
    for (const block of customBlocks) {
      const idx = displayBlocks.indexOf(block)
      const jsonEl = this.containerEl.querySelector(`tl-json[data-block-idx="${idx}"]`) as TlJson | null
      if (jsonEl) {
        jsonEl.json = block.raw.content
        jsonEl.placeholder = 'custom message'
      }
    }

    // Set input value
    const inputEl = this.containerEl.querySelector('#msg-input') as HTMLTextAreaElement | null
    if (inputEl) {
      inputEl.value = this.inputValue
    }

    this.attachListeners()

    // Set up settings components
    this.attachInlineSettingsListeners()

    // Scroll messages to bottom only if user hasn't scrolled up
    this.messagesEl = this.containerEl.querySelector('#messages-el')
    if (this.messagesEl) {
      if (!this.userScrolledUp) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight
      }
      this.messagesEl.addEventListener('scroll', this.handleMessagesScroll)
    }
  }

  private attachSetupSettingsListeners() {
    const settingsEl = this.containerEl.querySelector('#setup-settings') as any
    if (settingsEl && this.authConfig) {
      settingsEl.authConfig = this.authConfig
      settingsEl.addEventListener('config-change', (e: Event) => this.handleConfigChange(e))
      settingsEl.addEventListener('reconnect', () => this.handleReconnect())
    }
  }

  private attachInlineSettingsListeners() {
    const settingsEl = this.containerEl.querySelector('#inline-settings') as any
    if (settingsEl && this.authConfig) {
      settingsEl.authConfig = this.authConfig
      settingsEl.showTools = this.showTools
      settingsEl.disabled = this.isStreaming
      settingsEl.addEventListener('config-change', (e: Event) => this.handleConfigChange(e))
      settingsEl.addEventListener('reconnect', () => this.handleReconnect())
      settingsEl.addEventListener('tools-toggle', (e: Event) => {
        this.showTools = (e as CustomEvent<boolean>).detail
        this.render()
      })
    }
  }

  private attachListeners() {
    // Session indicator
    const indicator = this.containerEl.querySelector('#session-indicator')
    if (indicator) {
      indicator.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.toggleSessionPanel()
      })
    }

    // Stop button
    const stopBtn = this.containerEl.querySelector('#stop-btn')
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this.handleStop())
    }

    // Tool lines
    const toolLines = this.containerEl.querySelectorAll('.tool-line[data-tool-id]')
    toolLines.forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        const toolId = (el as HTMLElement).dataset.toolId
        if (toolId) this.toggleTool(toolId)
      })
    })

    // Input
    const inputEl = this.containerEl.querySelector('#msg-input')
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => this.handleKeydown(e as KeyboardEvent))
      inputEl.addEventListener('input', (e) => this.handleInput(e))
    }

    // New session button in toolbar
    const newSessionBtn = this.containerEl.querySelector('#new-session-action-btn')
    if (newSessionBtn) {
      newSessionBtn.addEventListener('click', () => this.handleNewSession())
    }

    // Sessions button
    const sessionsBtn = this.containerEl.querySelector('#sessions-btn')
    if (sessionsBtn) {
      sessionsBtn.addEventListener('click', () => this.toggleSessionPanel())
    }

    // Settings button
    const settingsBtn = this.containerEl.querySelector('#settings-btn')
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.showSettings = !this.showSettings
        this.render()
      })
    }

    // New session in panel
    const newSessionPanelBtn = this.containerEl.querySelector('#new-session-btn')
    if (newSessionPanelBtn) {
      newSessionPanelBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.handleNewSession()
      })
    }

    // Session items in panel
    const sessionItems = this.containerEl.querySelectorAll('.session-panel-item[data-session-idx]')
    sessionItems.forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        const idx = parseInt((el as HTMLElement).dataset.sessionIdx!, 10)
        const item = this.sessionListItems[idx]
        if (item) this.handleSessionClick(item)
      })
    })
  }
}
