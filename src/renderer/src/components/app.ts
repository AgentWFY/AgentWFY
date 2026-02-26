import { initApp, destroyApp } from 'app/interactors/app'
import type { PendingSqlConfirmation } from 'app/types'

export class TlApp extends HTMLElement {
  private isAgentChatOpen = false
  private agentPanelEl!: HTMLDivElement
  private sqlModalEl!: HTMLElement

  private onToggleAgentChat = () => {
    this.isAgentChatOpen = !this.isAgentChatOpen
    this.updateAgentPanel()
  }

  private onSqlConfirmationNeeded = (e: Event) => {
    const detail = (e as CustomEvent<PendingSqlConfirmation>).detail
    ;(this.sqlModalEl as any).pending = detail
  }

  private onSqlConfirmationCleared = () => {
    ;(this.sqlModalEl as any).pending = null
  }

  connectedCallback() {
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = '100%'
    this.style.minHeight = '0'
    this.style.minWidth = '0'

    const style = document.createElement('style')
    style.textContent = `
      .tl-app-container {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100vh;
      }
      .tl-app-content {
        flex: 1;
        overflow: hidden;
        display: flex;
        min-height: 0;
        min-width: 0;
      }
      .tl-app-main-area {
        flex: 1;
        overflow: hidden;
        display: grid;
        min-height: 0;
        min-width: 0;
      }
      .tl-app-agent-panel {
        width: 420px;
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        min-height: 0;
        border-left: 1px solid var(--color-border);
        overflow: hidden;
      }
      .tl-app-agent-panel > tl-agent-chat {
        display: block;
        flex: 1;
        min-height: 0;
      }
      .tl-app-agent-panel-hidden {
        display: none;
      }
    `
    this.appendChild(style)

    const theme = document.createElement('sp-theme')
    theme.setAttribute('scale', 'medium')
    theme.setAttribute('color', 'dark')

    const iconsMedium = document.createElement('sp-icons-medium')
    theme.appendChild(iconsMedium)

    const container = document.createElement('div')
    container.className = 'tl-app-container'

    // Content area
    const content = document.createElement('div')
    content.className = 'tl-app-content'

    const mainArea = document.createElement('div')
    mainArea.className = 'tl-app-main-area'
    const tabs = document.createElement('tl-tabs')
    mainArea.appendChild(tabs)
    content.appendChild(mainArea)

    // Agent panel
    this.agentPanelEl = document.createElement('div')
    this.agentPanelEl.className = 'tl-app-agent-panel tl-app-agent-panel-hidden'
    const agentChat = document.createElement('tl-agent-chat')
    this.agentPanelEl.appendChild(agentChat)
    content.appendChild(this.agentPanelEl)

    container.appendChild(content)
    theme.appendChild(container)

    // SQL Modal
    this.sqlModalEl = document.createElement('tl-sql-modal')
    theme.appendChild(this.sqlModalEl)

    this.appendChild(theme)

    // Event listeners
    window.addEventListener('tradinglog:toggle-agent-chat', this.onToggleAgentChat)
    window.addEventListener('tradinglog:sql-confirmation-needed', this.onSqlConfirmationNeeded)
    window.addEventListener('tradinglog:sql-confirmation-cleared', this.onSqlConfirmationCleared)

    initApp()
  }

  disconnectedCallback() {
    window.removeEventListener('tradinglog:toggle-agent-chat', this.onToggleAgentChat)
    window.removeEventListener('tradinglog:sql-confirmation-needed', this.onSqlConfirmationNeeded)
    window.removeEventListener('tradinglog:sql-confirmation-cleared', this.onSqlConfirmationCleared)
    destroyApp()
  }

  private updateAgentPanel() {
    if (this.isAgentChatOpen) {
      this.agentPanelEl.classList.remove('tl-app-agent-panel-hidden')
    } else {
      this.agentPanelEl.classList.add('tl-app-agent-panel-hidden')
    }
  }
}
