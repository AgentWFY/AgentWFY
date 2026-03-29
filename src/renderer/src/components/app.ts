import type { AgentDbChange } from '../ipc-types/index.js'

const SIDEBAR_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
  <line x1="9" y1="3" x2="9" y2="21"/>
</svg>`

const AGENT_SIDEBAR_WIDTH = 78

export class TlApp extends HTMLElement {
  private activeSidebarPanel: string | null = null
  private sidebarEl!: HTMLDivElement
  private sidebarTopEl!: HTMLDivElement
  private sidebarSwitcherEl!: HTMLDivElement
  private sidebarToggleBtnEl!: HTMLButtonElement
  private inlineToggleBtnEl!: HTMLButtonElement
  private resizeHandleEl!: HTMLDivElement
  private agentChatEl!: HTMLElement
  private taskPanelEl!: HTMLElement
  private tabsEl!: HTMLElement
  private unlistenAgentDbChanged: (() => void) | null = null
  private rootEl!: HTMLDivElement
  private sidebarWidth = 380
  private isResizing = false
  private isZenMode = false

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

  private toggleSidebar = () => {
    if (this.activeSidebarPanel) {
      this.activeSidebarPanel = null
    } else {
      this.activeSidebarPanel = 'agent-chat'
    }
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

  private onToggleZenMode = () => {
    if (!this.activeSidebarPanel) {
      this.activeSidebarPanel = 'agent-chat'
    }
    this.isZenMode = !this.isZenMode
    this.updateSidebar()
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
    const newWidth = Math.min(Math.max(e.clientX - AGENT_SIDEBAR_WIDTH, 200), window.innerWidth - AGENT_SIDEBAR_WIDTH - 4)
    this.sidebarWidth = newWidth
    this.sidebarEl.style.width = `${newWidth}px`
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

    const style = document.createElement('style')
    style.textContent = `
      .awfy-app-root {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100vh;
      }
      .awfy-app-body {
        display: flex;
        flex: 1;
        min-height: 0;
      }
      /* ── Sidebar: full-height column ── */
      .awfy-app-sidebar {
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
        min-height: 0;
        border-right: 1px solid var(--color-border);
        background: var(--color-sidebar-bg);
        overflow: hidden;
      }
      .awfy-app-sidebar.closed {
        width: 0 !important;
        border-right: none;
      }
      .awfy-app-sidebar-top {
        display: flex;
        align-items: center;
        height: 42px;
        padding: 0 8px;
        gap: 6px;
        flex-shrink: 0;
        background: var(--color-sidebar-bg);
        -webkit-app-region: drag;
        min-width: max-content;
      }
      .awfy-app-sidebar-toggle {
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
        flex-shrink: 0;
        padding: 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
      }
      .awfy-app-sidebar-toggle:hover {
        color: var(--color-text4);
        background: var(--color-item-hover);
      }
      .awfy-app-sidebar-switcher {
        display: flex;
        align-items: center;
        background: color-mix(in srgb, var(--color-bg2) 80%, var(--color-bg3));
        border-radius: var(--radius-md);
        padding: 2px;
        gap: 1px;
        -webkit-app-region: no-drag;
      }
      .awfy-app-sidebar-switcher-btn {
        display: flex;
        align-items: center;
        height: 24px;
        padding: 0 10px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--color-text2);
        font-size: 11.5px;
        font-family: var(--font-family);
        cursor: pointer;
        transition: all var(--transition-fast);
        white-space: nowrap;
      }
      .awfy-app-sidebar-switcher-btn:hover {
        color: var(--color-text3);
      }
      .awfy-app-sidebar-switcher-btn.active {
        color: var(--color-text4);
        background: var(--color-bg1);
        font-weight: 500;
        box-shadow: 0 0.5px 2px rgba(0,0,0,0.06);
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
      /* ── Resize handle ── */
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
      .awfy-app-resize-handle.resize-hover {
        background: var(--color-accent);
      }
      .awfy-app-resize-handle-hidden {
        display: none;
      }
      /* ── Main column (tab bar + content) ── */
      .awfy-app-main-column {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        min-height: 0;
      }
      .awfy-app-header {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        height: 42px;
        box-sizing: border-box;
        background: var(--color-bg3);
        border-bottom: 1px solid var(--color-border);
        padding: 0 10px 0 6px;
        gap: 4px;
        -webkit-app-region: drag;
      }
      .awfy-app-header > .tab-bar {
        flex: 1;
        min-width: 0;
      }
      /* Inline sidebar toggle (shown when sidebar is closed) */
      .awfy-app-inline-toggle {
        display: none;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text2);
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        margin-right: 2px;
      }
      .awfy-app-inline-toggle:hover {
        color: var(--color-text4);
        background: var(--color-item-hover);
      }
      .awfy-app-inline-toggle.visible {
        display: flex;
      }
      .awfy-app-main-area {
        flex: 1;
        overflow: hidden;
        display: grid;
        min-height: 0;
        min-width: 0;
      }
      /* ── Zen mode ── */
      .awfy-app-root.zen-mode > .awfy-app-body > awfy-agent-sidebar,
      .awfy-app-root.zen-mode > awfy-status-line,
      .awfy-app-root.zen-mode > .awfy-app-body > .awfy-app-resize-handle,
      .awfy-app-root.zen-mode > .awfy-app-body > .awfy-app-main-column,
      .awfy-app-root.zen-mode > .awfy-app-body > .awfy-app-sidebar > .awfy-app-sidebar-top {
        display: none !important;
      }
      .awfy-app-root.zen-mode > .awfy-app-body > .awfy-app-sidebar {
        flex: 1;
        border-right: none;
      }
    `
    this.appendChild(style)

    // Root: column with body + status line
    this.rootEl = document.createElement('div')
    const root = this.rootEl
    root.className = 'awfy-app-root'

    // Body: agent-sidebar + sidebar + main column
    const body = document.createElement('div')
    body.className = 'awfy-app-body'

    // Agent sidebar (Discord-style)
    const agentSidebar = document.createElement('awfy-agent-sidebar')
    body.appendChild(agentSidebar)

    // ── Sidebar (full-height: own top bar + chat/tasks) ──
    this.sidebarEl = document.createElement('div')
    this.sidebarEl.className = 'awfy-app-sidebar closed'
    this.sidebarEl.style.width = `${this.sidebarWidth}px`

    // Sidebar top bar
    this.sidebarTopEl = document.createElement('div')
    this.sidebarTopEl.className = 'awfy-app-sidebar-top'

    this.sidebarToggleBtnEl = document.createElement('button')
    this.sidebarToggleBtnEl.className = 'awfy-app-sidebar-toggle'
    this.sidebarToggleBtnEl.title = 'Close sidebar'
    this.sidebarToggleBtnEl.innerHTML = SIDEBAR_ICON
    this.sidebarToggleBtnEl.addEventListener('click', this.toggleSidebar)
    this.sidebarTopEl.appendChild(this.sidebarToggleBtnEl)

    this.sidebarSwitcherEl = document.createElement('div')
    this.sidebarSwitcherEl.className = 'awfy-app-sidebar-switcher'
    this.sidebarSwitcherEl.innerHTML = `
      <button class="awfy-app-sidebar-switcher-btn active" data-panel="agent-chat">Chat</button>
      <button class="awfy-app-sidebar-switcher-btn" data-panel="tasks">Tasks</button>
    `
    this.sidebarSwitcherEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.awfy-app-sidebar-switcher-btn') as HTMLElement | null
      if (!btn) return
      const panel = btn.dataset.panel!
      if (panel !== this.activeSidebarPanel) {
        this.activeSidebarPanel = panel
        this.updateSidebar()
      }
    })
    this.sidebarTopEl.appendChild(this.sidebarSwitcherEl)

    this.sidebarEl.appendChild(this.sidebarTopEl)

    // Chat and tasks panels
    this.agentChatEl = document.createElement('awfy-agent-chat')
    this.agentChatEl.classList.add('panel-hidden')
    this.sidebarEl.appendChild(this.agentChatEl)

    this.taskPanelEl = document.createElement('awfy-task-panel')
    this.taskPanelEl.classList.add('panel-hidden')
    this.sidebarEl.appendChild(this.taskPanelEl)

    body.appendChild(this.sidebarEl)

    // Resize handle
    this.resizeHandleEl = document.createElement('div')
    this.resizeHandleEl.className = 'awfy-app-resize-handle awfy-app-resize-handle-hidden'
    this.resizeHandleEl.addEventListener('mousedown', this.onResizeMouseDown)
    this.resizeHandleEl.addEventListener('mouseenter', () => this.resizeHandleEl.classList.add('resize-hover'))
    this.resizeHandleEl.addEventListener('mouseleave', () => this.resizeHandleEl.classList.remove('resize-hover'))
    body.appendChild(this.resizeHandleEl)

    // ── Main column (header + content) ──
    const mainColumn = document.createElement('div')
    mainColumn.className = 'awfy-app-main-column'

    // Header (inline toggle + tab bar)
    const headerEl = document.createElement('div')
    headerEl.className = 'awfy-app-header'

    this.inlineToggleBtnEl = document.createElement('button')
    this.inlineToggleBtnEl.className = 'awfy-app-inline-toggle visible'
    this.inlineToggleBtnEl.title = 'Open sidebar'
    this.inlineToggleBtnEl.innerHTML = SIDEBAR_ICON
    this.inlineToggleBtnEl.addEventListener('click', this.toggleSidebar)
    headerEl.appendChild(this.inlineToggleBtnEl)

    this.tabsEl = document.createElement('awfy-tabs')
    const mainArea = document.createElement('div')
    mainArea.className = 'awfy-app-main-area'
    mainArea.appendChild(this.tabsEl)

    mainColumn.appendChild(headerEl)
    mainColumn.appendChild(mainArea)

    body.appendChild(mainColumn)
    root.appendChild(body)

    // Status line
    const statusLine = document.createElement('awfy-status-line')
    root.appendChild(statusLine)

    this.appendChild(root)

    // Reparent tab bar into the header (must be after DOM insertion so connectedCallback has fired)
    const tabsComponent = this.tabsEl as HTMLElement & { tabBarEl?: HTMLDivElement }
    if (tabsComponent.tabBarEl) {
      headerEl.appendChild(tabsComponent.tabBarEl)
    }

    // Event listeners
    this.addEventListener('panel-toggle', this.onPanelToggle)
    window.addEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.addEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.addEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    window.addEventListener('agentwfy:toggle-zen-mode', this.onToggleZenMode)
    this.subscribeToAgentDbChanges()
  }

  disconnectedCallback() {
    this.removeEventListener('panel-toggle', this.onPanelToggle)
    window.removeEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.removeEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.removeEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    window.removeEventListener('agentwfy:toggle-zen-mode', this.onToggleZenMode)
    document.removeEventListener('mousemove', this.onResizeMouseMove)
    document.removeEventListener('mouseup', this.onResizeMouseUp)
    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = null
  }

  private updateSidebar() {
    const isOpen = !!this.activeSidebarPanel

    // Exit zen mode when sidebar is closed
    if (!isOpen && this.isZenMode) {
      this.isZenMode = false
    }

    // Zen mode + sidebar open/close
    this.rootEl.classList.toggle('zen-mode', this.isZenMode)
    this.sidebarEl.classList.toggle('closed', !isOpen)
    if (this.isZenMode) {
      this.sidebarEl.style.width = ''
    } else {
      this.sidebarEl.style.width = `${this.sidebarWidth}px`
    }
    this.resizeHandleEl.classList.toggle('awfy-app-resize-handle-hidden', !isOpen || this.isZenMode)
    this.inlineToggleBtnEl.classList.toggle('visible', !isOpen)

    // Panel visibility
    const agentChatVisible = this.activeSidebarPanel === 'agent-chat'
    this.agentChatEl.classList.toggle('panel-hidden', !agentChatVisible)
    this.taskPanelEl.classList.toggle('panel-hidden', this.activeSidebarPanel !== 'tasks')

    if (agentChatVisible) {
      requestAnimationFrame(() => {
        (this.agentChatEl as any).focusInput?.()
      })
    }

    // Switcher active state
    this.sidebarSwitcherEl.querySelectorAll('.awfy-app-sidebar-switcher-btn').forEach(btn => {
      const panel = (btn as HTMLElement).dataset.panel
      btn.classList.toggle('active', panel === this.activeSidebarPanel)
    })

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

      if (change.table === 'config') {
        window.dispatchEvent(new CustomEvent('agentwfy:config-db-changed'))
      }
    })
  }
}
