import type { AgentDbChange } from '../ipc-types/index.js'

const CHAT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`

const TASKS_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="5 3 19 12 5 21 5 3"/>
</svg>`

export class TlApp extends HTMLElement {
  private activeSidebarPanel: string | null = null
  private sidebarEl!: HTMLDivElement
  private sidebarButtonsEl!: HTMLDivElement
  private sidebarHeaderEl!: HTMLDivElement
  private headerSpacerEl!: HTMLDivElement
  private headerResizeSpacerEl!: HTMLDivElement
  private headerEl!: HTMLDivElement
  private resizeHandleEl!: HTMLDivElement
  private agentChatEl!: HTMLElement
  private taskPanelEl!: HTMLElement
  private tabsEl!: HTMLElement
  private unlistenAgentDbChanged: (() => void) | null = null
  private sidebarWidth = 380
  private isResizing = false

  private openPanel(panel: string) {
    if (this.activeSidebarPanel !== panel) {
      this.activeSidebarPanel = panel
      this.updateSidebar()
    }
  }

  private togglePanel(panel: string) {
    this.activeSidebarPanel = this.activeSidebarPanel === panel ? null : panel
    this.updateSidebar()
  }

  private onPanelToggle = (e: Event) => {
    this.togglePanel((e as CustomEvent<{ panel: string }>).detail.panel)
  }

  private onToggleAgentChat = () => {
    this.togglePanel('agent-chat')
  }

  private onToggleTaskPanel = () => {
    this.togglePanel('tasks')
  }

  private onOpenSidebarPanel = (e: Event) => {
    this.openPanel((e as CustomEvent<{ panel: string }>).detail.panel)
  }

  private onResizeMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    this.isResizing = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', this.onResizeMouseMove)
    document.addEventListener('mouseup', this.onResizeMouseUp)
  }

  private onResizeMouseMove = (e: MouseEvent) => {
    if (!this.isResizing) return
    const newWidth = Math.min(Math.max(e.clientX, 200), 800)
    this.sidebarWidth = newWidth
    this.sidebarEl.style.width = `${newWidth}px`
    this.updateHeaderSpacer()
    window.dispatchEvent(new Event('resize'))
  }

  private onResizeMouseUp = () => {
    this.isResizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', this.onResizeMouseMove)
    document.removeEventListener('mouseup', this.onResizeMouseUp)
  }

  connectedCallback() {
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = '100%'
    this.style.minHeight = '0'
    this.style.minWidth = '0'

    const isMac = navigator.platform.includes('Mac')

    const style = document.createElement('style')
    style.textContent = `
      .awfy-app-outer {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100vh;
      }
      .awfy-app-header {
        display: flex;
        flex-shrink: 0;
        background: var(--color-bg3);
        -webkit-app-region: drag;
      }
      .awfy-app-header > .tab-bar {
        flex: 1;
        min-width: 0;
      }
      .awfy-app-sidebar-header {
        display: flex;
        flex-shrink: 0;
      }
      .awfy-app-sidebar-header.open {
        background: var(--color-sidebar-bg);
        border-right: 1px solid var(--color-border);
      }
      .awfy-app-sidebar-buttons {
        display: flex;
        align-items: flex-end;
        flex-shrink: 0;
        height: 36px;
        gap: 2px;
        padding: 0 4px 2px;
        -webkit-app-region: no-drag;
        ${isMac ? 'padding-left: 78px;' : ''}
      }
      .awfy-app-sidebar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text2);
        cursor: pointer;
        padding: 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        user-select: none;
      }
      .awfy-app-sidebar-btn:hover {
        color: var(--color-text4);
        background: var(--color-item-hover);
      }
      .awfy-app-sidebar-btn.active {
        color: var(--color-text4);
        background: var(--color-item-active);
      }
      .awfy-app-header-spacer {
        flex-shrink: 0;
      }
      .awfy-app-header-resize-spacer {
        width: 4px;
        flex-shrink: 0;
        margin-left: -4px;
        position: relative;
        z-index: 1;
        cursor: col-resize;
        background: transparent;
        transition: background var(--transition-fast);
        -webkit-app-region: no-drag;
      }
      .awfy-app-resize-handle.resize-hover,
      .awfy-app-header-resize-spacer.resize-hover {
        background: var(--color-accent);
      }
      .awfy-app-container {
        display: flex;
        flex: 1;
        min-height: 0;
      }
      .awfy-app-sidebar {
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        min-height: 0;
        border-right: 1px solid var(--color-border);
        background: var(--color-sidebar-bg);
        overflow: hidden;
      }
      .awfy-app-sidebar > awfy-agent-chat,
      .awfy-app-sidebar > awfy-task-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }
      .awfy-app-sidebar > .panel-hidden {
        display: none !important;
      }
      .awfy-app-sidebar-hidden {
        display: none;
      }
      .awfy-app-resize-handle {
        width: 4px;
        cursor: col-resize;
        flex-shrink: 0;
        margin-left: -4px;
        position: relative;
        z-index: 1;
        background: transparent;
        transition: background var(--transition-fast);
      }
      .awfy-app-resize-handle-hidden {
        display: none;
      }
      .awfy-app-main-area {
        flex: 1;
        overflow: hidden;
        display: grid;
        min-height: 0;
        min-width: 0;
      }
    `
    this.appendChild(style)

    const outer = document.createElement('div')
    outer.className = 'awfy-app-outer'

    // Header row: sidebar-header (buttons + spacer) + resize spacer + tab bar
    this.headerEl = document.createElement('div')
    this.headerEl.className = 'awfy-app-header'

    this.sidebarHeaderEl = document.createElement('div')
    this.sidebarHeaderEl.className = 'awfy-app-sidebar-header'

    this.sidebarButtonsEl = document.createElement('div')
    this.sidebarButtonsEl.className = 'awfy-app-sidebar-buttons'
    this.sidebarButtonsEl.innerHTML = `
      <button class="awfy-app-sidebar-btn" data-panel="agent-chat" title="Agent Chat">${CHAT_ICON}</button>
      <button class="awfy-app-sidebar-btn" data-panel="tasks" title="Tasks">${TASKS_ICON}</button>
    `
    this.sidebarButtonsEl.querySelectorAll('.awfy-app-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const panel = (btn as HTMLElement).dataset.panel!
        this.dispatchEvent(new CustomEvent('panel-toggle', {
          detail: { panel },
          bubbles: true,
          composed: true,
        }))
      })
    })
    this.sidebarHeaderEl.appendChild(this.sidebarButtonsEl)

    this.headerSpacerEl = document.createElement('div')
    this.headerSpacerEl.className = 'awfy-app-header-spacer'
    this.headerSpacerEl.style.display = 'none'
    this.sidebarHeaderEl.appendChild(this.headerSpacerEl)

    this.headerEl.appendChild(this.sidebarHeaderEl)

    this.headerResizeSpacerEl = document.createElement('div')
    this.headerResizeSpacerEl.className = 'awfy-app-header-resize-spacer'
    this.headerResizeSpacerEl.style.display = 'none'
    this.headerResizeSpacerEl.addEventListener('mousedown', this.onResizeMouseDown)
    this.headerEl.appendChild(this.headerResizeSpacerEl)

    outer.appendChild(this.headerEl)

    // Content row
    const container = document.createElement('div')
    container.className = 'awfy-app-container'

    // Sidebar
    this.sidebarEl = document.createElement('div')
    this.sidebarEl.className = 'awfy-app-sidebar awfy-app-sidebar-hidden'
    this.sidebarEl.style.width = `${this.sidebarWidth}px`
    this.agentChatEl = document.createElement('awfy-agent-chat')
    this.agentChatEl.classList.add('panel-hidden')
    this.sidebarEl.appendChild(this.agentChatEl)
    this.taskPanelEl = document.createElement('awfy-task-panel')
    this.taskPanelEl.classList.add('panel-hidden')
    this.sidebarEl.appendChild(this.taskPanelEl)
    container.appendChild(this.sidebarEl)

    // Resize handle
    this.resizeHandleEl = document.createElement('div')
    this.resizeHandleEl.className = 'awfy-app-resize-handle awfy-app-resize-handle-hidden'
    this.resizeHandleEl.addEventListener('mousedown', this.onResizeMouseDown)
    container.appendChild(this.resizeHandleEl)

    // Main area
    const mainArea = document.createElement('div')
    mainArea.className = 'awfy-app-main-area'
    this.tabsEl = document.createElement('awfy-tabs')
    mainArea.appendChild(this.tabsEl)
    container.appendChild(mainArea)

    // Sync hover on both resize elements
    const addResizeHover = () => {
      this.resizeHandleEl.classList.add('resize-hover')
      this.headerResizeSpacerEl.classList.add('resize-hover')
    }
    const removeResizeHover = () => {
      this.resizeHandleEl.classList.remove('resize-hover')
      this.headerResizeSpacerEl.classList.remove('resize-hover')
    }
    this.resizeHandleEl.addEventListener('mouseenter', addResizeHover)
    this.resizeHandleEl.addEventListener('mouseleave', removeResizeHover)
    this.headerResizeSpacerEl.addEventListener('mouseenter', addResizeHover)
    this.headerResizeSpacerEl.addEventListener('mouseleave', removeResizeHover)

    outer.appendChild(container)

    // Status line
    const statusLine = document.createElement('awfy-status-line')
    outer.appendChild(statusLine)

    this.appendChild(outer)

    // Reparent tab bar from awfy-tabs into the header
    const tabsComponent = this.tabsEl as HTMLElement & { tabBarEl?: HTMLDivElement }
    if (tabsComponent.tabBarEl) {
      this.headerEl.appendChild(tabsComponent.tabBarEl)
    }

    // Event listeners
    this.addEventListener('panel-toggle', this.onPanelToggle)
    window.addEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.addEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.addEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    this.subscribeToAgentDbChanges()
  }

  disconnectedCallback() {
    this.removeEventListener('panel-toggle', this.onPanelToggle)
    window.removeEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.removeEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.removeEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    document.removeEventListener('mousemove', this.onResizeMouseMove)
    document.removeEventListener('mouseup', this.onResizeMouseUp)
    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = null
  }

  private updateHeaderSpacer() {
    if (this.activeSidebarPanel) {
      const buttonsWidth = this.sidebarButtonsEl.offsetWidth
      const spacerWidth = Math.max(0, this.sidebarWidth - buttonsWidth)
      this.headerSpacerEl.style.display = ''
      this.headerSpacerEl.style.width = `${spacerWidth}px`
      this.sidebarHeaderEl.classList.add('open')
      this.headerResizeSpacerEl.style.display = ''
    } else {
      this.headerSpacerEl.style.display = 'none'
      this.sidebarHeaderEl.classList.remove('open')
      this.headerResizeSpacerEl.style.display = 'none'
    }
  }

  private updateSidebar() {
    const isOpen = !!this.activeSidebarPanel
    this.sidebarEl.classList.toggle('awfy-app-sidebar-hidden', !isOpen)
    this.resizeHandleEl.classList.toggle('awfy-app-resize-handle-hidden', !isOpen)

    const agentChatVisible = this.activeSidebarPanel === 'agent-chat'
    this.agentChatEl.classList.toggle('panel-hidden', !agentChatVisible)
    this.taskPanelEl.classList.toggle('panel-hidden', this.activeSidebarPanel !== 'tasks')

    if (agentChatVisible) {
      requestAnimationFrame(() => {
        (this.agentChatEl as any).focusInput?.()
      })
    }

    this.sidebarButtonsEl.querySelectorAll('.awfy-app-sidebar-btn').forEach(btn => {
      const panel = (btn as HTMLElement).dataset.panel
      btn.classList.toggle('active', panel === this.activeSidebarPanel)
    })

    this.updateHeaderSpacer()
    window.dispatchEvent(new Event('resize'))
  }

  private subscribeToAgentDbChanges() {
    const ipc = window.ipc
    if (!ipc) {
      return
    }

    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = ipc.db.onDbChanged((change: AgentDbChange) => {
      if (!change) return
      if (change.op !== 'insert' && change.op !== 'update' && change.op !== 'delete') return
      if (typeof change.rowId !== 'number' || !Number.isFinite(change.rowId)) return

      if (change.table === 'views') {
        window.dispatchEvent(new CustomEvent<{ change: AgentDbChange }>('agentwfy:views-db-changed', {
          detail: { change }
        }))
      }

      if (change.table === 'tasks') {
        window.dispatchEvent(new CustomEvent('agentwfy:tasks-db-changed'))
      }

      if (change.table === 'triggers') {
        window.dispatchEvent(new CustomEvent('agentwfy:triggers-db-changed'))
      }
    })
  }
}
