/* eslint-disable import/no-unresolved */
import type { ElectronAgentDbChange } from 'app/electron_agent_tools'

export class TlApp extends HTMLElement {
  private activeSidebarPanel: string | null = null
  private sidebarEl!: HTMLDivElement
  private activityBarEl!: HTMLElement
  private unlistenAgentDbChanged: (() => void) | null = null

  private onPanelToggle = (e: Event) => {
    const detail = (e as CustomEvent<{ panel: string }>).detail
    if (this.activeSidebarPanel === detail.panel) {
      this.activeSidebarPanel = null
    } else {
      this.activeSidebarPanel = detail.panel
    }
    this.updateSidebar()
  }

  private onToggleAgentChat = () => {
    if (this.activeSidebarPanel === 'agent-chat') {
      this.activeSidebarPanel = null
    } else {
      this.activeSidebarPanel = 'agent-chat'
    }
    this.updateSidebar()
  }

  connectedCallback() {
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = '100%'
    this.style.minHeight = '0'
    this.style.minWidth = '0'

    const style = document.createElement('style')
    style.textContent = `
      .tl-app-outer {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100vh;
      }
      .tl-app-container {
        display: flex;
        flex: 1;
        min-height: 0;
      }
      .tl-app-sidebar {
        width: var(--sidebar-width);
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        min-height: 0;
        border-right: 1px solid var(--color-border);
        background: var(--color-sidebar-bg);
        overflow: hidden;
      }
      .tl-app-sidebar > tl-agent-chat {
        display: block;
        flex: 1;
        min-height: 0;
      }
      .tl-app-sidebar-hidden {
        display: none;
      }
      .tl-app-main-area {
        flex: 1;
        overflow: hidden;
        display: grid;
        min-height: 0;
        min-width: 0;
      }
    `
    this.appendChild(style)

    const outer = document.createElement('div')
    outer.className = 'tl-app-outer'

    const container = document.createElement('div')
    container.className = 'tl-app-container'

    // Activity bar
    this.activityBarEl = document.createElement('tl-activity-bar')
    container.appendChild(this.activityBarEl)

    // Sidebar
    this.sidebarEl = document.createElement('div')
    this.sidebarEl.className = 'tl-app-sidebar tl-app-sidebar-hidden'
    const agentChat = document.createElement('tl-agent-chat')
    this.sidebarEl.appendChild(agentChat)
    container.appendChild(this.sidebarEl)

    // Main area
    const mainArea = document.createElement('div')
    mainArea.className = 'tl-app-main-area'
    const tabs = document.createElement('tl-tabs')
    mainArea.appendChild(tabs)
    container.appendChild(mainArea)

    outer.appendChild(container)

    // Status line
    const statusLine = document.createElement('tl-status-line')
    outer.appendChild(statusLine)

    this.appendChild(outer)

    // Event listeners
    this.addEventListener('panel-toggle', this.onPanelToggle)
    window.addEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    this.subscribeToAgentDbChanges()
  }

  disconnectedCallback() {
    this.removeEventListener('panel-toggle', this.onPanelToggle)
    window.removeEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = null
  }

  private updateSidebar() {
    if (this.activeSidebarPanel) {
      this.sidebarEl.classList.remove('tl-app-sidebar-hidden')
    } else {
      this.sidebarEl.classList.add('tl-app-sidebar-hidden')
    }
    (this.activityBarEl as unknown as { activePanel: string | null }).activePanel = this.activeSidebarPanel
  }

  private subscribeToAgentDbChanges() {
    const tools = window.electronClientTools
    if (!tools?.onAgentDbChanged) {
      return
    }

    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = tools.onAgentDbChanged((change: ElectronAgentDbChange) => {
      if (!change || change.table !== 'views') return
      if (change.op !== 'insert' && change.op !== 'update' && change.op !== 'delete') return
      if (typeof change.rowId !== 'number' || !Number.isFinite(change.rowId)) return

      window.dispatchEvent(new CustomEvent<{ change: ElectronAgentDbChange }>('agentwfy:views-db-changed', {
        detail: { change }
      }))
    })
  }
}
