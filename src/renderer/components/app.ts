import type { AgentDbChange } from '../ipc-types/index.js'
import { SystemConfigKeys } from '../../system-config/keys.js'

const SIDEBAR_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
  <line x1="9" y1="3" x2="9" y2="21"/>
</svg>`

const AGENT_SIDEBAR_WIDTH = 78

const CHROME_CONFIG_KEYS = new Set<string>([
  SystemConfigKeys.hideAgentSidebar,
  SystemConfigKeys.hidePanelSwitcher,
  SystemConfigKeys.hidePanelToggle,
  SystemConfigKeys.hideStatusLine,
  SystemConfigKeys.hideTabs,
  SystemConfigKeys.hideTrafficLights,
])

function isTruthyConfig(value: unknown): boolean {
  const v = String(value ?? '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export class TlApp extends HTMLElement {
  private activeSidebarPanel: string | null = 'agent-chat'
  private sidebarEl!: HTMLDivElement
  private sidebarTopEl!: HTMLDivElement
  private sidebarSwitcherEl!: HTMLDivElement
  private sidebarToggleBtnEl!: HTMLButtonElement
  private inlineToggleBtnEl!: HTMLButtonElement
  private resizeHandleEl!: HTMLDivElement
  private agentChatEl!: HTMLElement
  private taskPanelEl!: HTMLElement
  private tabsEl!: HTMLElement
  private statusLineEl!: HTMLElement
  private unlistenAgentDbChanged: (() => void) | null = null
  private unlistenZenMode: (() => void) | null = null
  private unlistenSettingChanged: (() => void) | null = null
  private isPanelSwitcherHidden = false
  private isPanelToggleHidden = false
  private isStatusLineHidden = false
  private isTabsHidden = false
  private isTrafficLightsHidden = false
  private headerEl!: HTMLDivElement
  private rootEl!: HTMLDivElement
  private agentSidebarEl!: HTMLElement
  private sidebarWidth = 380
  private isResizing = false
  private resizeStartX = 0
  private resizeStartWidth = 0
  private _resizeDispatchPending: number | null = null
  private isZenMode = false
  private isAgentSidebarHidden = false

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

  private onZenModeChanged = (isZen: boolean) => {
    if (isZen && !this.activeSidebarPanel) {
      this.activeSidebarPanel = 'agent-chat'
    }
    this.isZenMode = isZen
    this.updateSidebar()
  }

  private onFocusChatInput = () => {
    if (this.activeSidebarPanel === 'agent-chat') {
      requestAnimationFrame(() => {
        (this.agentChatEl as any).focusInput?.()
      })
    }
  }

  private onResizeMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    this.isResizing = true
    this.resizeStartX = e.clientX
    this.resizeStartWidth = this.sidebarEl.getBoundingClientRect().width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', this.onResizeMouseMove)
    document.addEventListener('mouseup', this.onResizeMouseUp)
  }

  private onResizeMouseMove = (e: MouseEvent) => {
    if (!this.isResizing) return
    const delta = e.clientX - this.resizeStartX
    const agentSidebarWidth = this.isAgentSidebarHidden ? 0 : AGENT_SIDEBAR_WIDTH
    const maxWidth = window.innerWidth - agentSidebarWidth - 4
    const newWidth = Math.min(Math.max(this.resizeStartWidth + delta, 200), maxWidth)
    this.sidebarWidth = newWidth
    this.sidebarEl.style.width = `${newWidth}px`
    if (this._resizeDispatchPending === null) {
      this._resizeDispatchPending = requestAnimationFrame(() => {
        this._resizeDispatchPending = null
        window.dispatchEvent(new Event('resize'))
      })
    }
  }

  private onResizeMouseUp = () => {
    this.isResizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    if (this._resizeDispatchPending !== null) {
      cancelAnimationFrame(this._resizeDispatchPending)
      this._resizeDispatchPending = null
    }
    window.dispatchEvent(new Event('resize'))
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
        height: 30px;
        padding: 0 8px;
        gap: 6px;
        flex-shrink: 0;
        background: var(--color-sidebar-bg);
        -webkit-app-region: drag;
        min-width: max-content;
        transition: height var(--transition-fast);
      }
      :root.tabs-show-source .awfy-app-sidebar-top { height: 36px; }
      .awfy-app-sidebar-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
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
        height: 30px;
        box-sizing: border-box;
        background: var(--color-bg3);
        padding: 0;
        gap: 0;
        position: relative;
        -webkit-app-region: drag;
        transition: height var(--transition-fast);
      }
      .awfy-app-header::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 1px;
        background: var(--color-border);
        pointer-events: none;
      }
      :root.tabs-show-source .awfy-app-header { height: 36px; }
      .awfy-app-header > .tab-bar {
        flex: 1;
        min-width: 0;
        align-self: stretch;
      }
      /* Inline sidebar toggle (shown when sidebar is closed) */
      .awfy-app-inline-toggle {
        display: none;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text2);
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        margin-right: 8px;
      }
      .awfy-app-inline-toggle:hover {
        color: var(--color-text4);
        background: var(--color-item-hover);
      }
      .awfy-app-inline-toggle.visible {
        display: flex;
        margin-left: 8px;
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
      /* Traffic-light clearance: with trafficLightPosition x=13 the cluster ends ~x=65; place toggles at x=73 (8px gap). */
      .awfy-app-root.agent-sidebar-hidden > .awfy-app-body > .awfy-app-sidebar > .awfy-app-sidebar-top {
        padding-left: 73px;
      }
      .awfy-app-root.agent-sidebar-hidden > .awfy-app-body:has(> .awfy-app-sidebar.closed) > .awfy-app-main-column > .awfy-app-header {
        padding-left: 65px;
      }
      .awfy-app-root.agent-sidebar-hidden.panel-toggle-hidden > .awfy-app-body:has(> .awfy-app-sidebar.closed) > .awfy-app-main-column > .awfy-app-header {
        padding-left: 78px;
      }
      :root.traffic-lights-hidden .awfy-app-root.agent-sidebar-hidden > .awfy-app-body > .awfy-app-sidebar > .awfy-app-sidebar-top,
      :root.traffic-lights-hidden .awfy-app-root.agent-sidebar-hidden > .awfy-app-body:has(> .awfy-app-sidebar.closed) > .awfy-app-main-column > .awfy-app-header {
        padding-left: 0;
      }
      /* Agent sidebar border when chat panel is closed */
      awfy-agent-sidebar:has(+ .awfy-app-sidebar.closed) {
        border-right: 1px solid var(--color-border);
      }
      /* When chat panel is open, its border-right already separates it from the tab bar — drop the first tab's left border so they don't double up. */
      .awfy-app-body:has(> .awfy-app-sidebar:not(.closed)) .tab-item:first-child {
        border-left: none;
      }
      .awfy-app-root.agent-sidebar-visible.panel-toggle-hidden > .awfy-app-body:has(> .awfy-app-sidebar.closed) .tab-item:first-child {
        border-left: none;
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
    this.agentSidebarEl = document.createElement('awfy-agent-sidebar')
    body.appendChild(this.agentSidebarEl)

    // ── Sidebar (full-height: own top bar + chat/tasks) ──
    this.sidebarEl = document.createElement('div')
    this.sidebarEl.className = 'awfy-app-sidebar'
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
    this.headerEl = document.createElement('div')
    this.headerEl.className = 'awfy-app-header'

    this.inlineToggleBtnEl = document.createElement('button')
    this.inlineToggleBtnEl.className = 'awfy-app-inline-toggle'
    this.inlineToggleBtnEl.title = 'Open sidebar'
    this.inlineToggleBtnEl.innerHTML = SIDEBAR_ICON
    this.inlineToggleBtnEl.addEventListener('click', this.toggleSidebar)
    this.headerEl.appendChild(this.inlineToggleBtnEl)

    this.tabsEl = document.createElement('awfy-tabs')
    const mainArea = document.createElement('div')
    mainArea.className = 'awfy-app-main-area'
    mainArea.appendChild(this.tabsEl)

    mainColumn.appendChild(this.headerEl)
    mainColumn.appendChild(mainArea)

    body.appendChild(mainColumn)
    root.appendChild(body)

    // Status line
    this.statusLineEl = document.createElement('awfy-status-line')
    root.appendChild(this.statusLineEl)

    this.appendChild(root)

    // Reparent tab bar into the header (must be after DOM insertion so connectedCallback has fired)
    const tabsComponent = this.tabsEl as HTMLElement & { tabBarEl?: HTMLDivElement }
    if (tabsComponent.tabBarEl) {
      this.headerEl.appendChild(tabsComponent.tabBarEl)
    }

    // Event listeners
    this.addEventListener('panel-toggle', this.onPanelToggle)
    window.addEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.addEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.addEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    this.unlistenZenMode = window.ipc?.zenMode?.onChanged(this.onZenModeChanged) ?? null
    window.addEventListener('agentwfy:focus-chat-input', this.onFocusChatInput)
    this.subscribeToAgentDbChanges()
    // Three triggers: IPC settingChanged (global config writes),
    // config-db-changed (agent-DB config writes), agent-switched (DB swap).
    this.loadChromeConfig()
    this.unlistenSettingChanged = window.ipc?.onSettingChanged(({ key }) => {
      if (!CHROME_CONFIG_KEYS.has(key)) return
      this.loadChromeConfig()
    }) ?? null
    window.addEventListener('agentwfy:config-db-changed', this.onConfigDbChanged)
    window.addEventListener('agentwfy:agent-switched', this.onAgentSwitched)

    // Sync initial sidebar state (open chat panel by default)
    this.updateSidebar()
  }

  disconnectedCallback() {
    this.removeEventListener('panel-toggle', this.onPanelToggle)
    window.removeEventListener('agentwfy:toggle-agent-chat', this.onToggleAgentChat)
    window.removeEventListener('agentwfy:toggle-task-panel', this.onToggleTaskPanel)
    window.removeEventListener('agentwfy:open-sidebar-panel', this.onOpenSidebarPanel)
    this.unlistenZenMode?.()
    this.unlistenZenMode = null
    this.unlistenSettingChanged?.()
    this.unlistenSettingChanged = null
    window.removeEventListener('agentwfy:focus-chat-input', this.onFocusChatInput)
    window.removeEventListener('agentwfy:config-db-changed', this.onConfigDbChanged)
    window.removeEventListener('agentwfy:agent-switched', this.onAgentSwitched)
    document.removeEventListener('mousemove', this.onResizeMouseMove)
    document.removeEventListener('mouseup', this.onResizeMouseUp)
    this.unlistenAgentDbChanged?.()
    this.unlistenAgentDbChanged = null
  }

  private updateSidebar() {
    const isOpen = !!this.activeSidebarPanel

    // Exit zen mode when sidebar is closed
    if (!isOpen && this.isZenMode) {
      window.ipc?.zenMode?.set(false)
      return  // updateSidebar will be called again from onZenModeChanged
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
    this.sidebarToggleBtnEl.style.display = this.isPanelToggleHidden ? 'none' : ''
    this.inlineToggleBtnEl.classList.toggle('visible', !isOpen && !this.isPanelToggleHidden)
    this.agentSidebarEl.style.display = this.isAgentSidebarHidden ? 'none' : ''
    this.rootEl.classList.toggle('agent-sidebar-visible', !this.isAgentSidebarHidden)
    this.rootEl.classList.toggle('agent-sidebar-hidden', navigator.platform.includes('Mac') && this.isAgentSidebarHidden)
    this.rootEl.classList.toggle('panel-toggle-hidden', this.isPanelToggleHidden)
    this.statusLineEl.style.display = this.isStatusLineHidden ? 'none' : ''
    this.headerEl.style.display = this.isTabsHidden ? 'none' : ''

    // Panel visibility
    const agentChatVisible = this.activeSidebarPanel === 'agent-chat'
    this.agentChatEl.classList.toggle('panel-hidden', !agentChatVisible)
    this.taskPanelEl.classList.toggle('panel-hidden', this.activeSidebarPanel !== 'tasks')

    if (agentChatVisible) {
      requestAnimationFrame(() => {
        (this.agentChatEl as any).focusInput?.()
      })
    }

    // Hide switcher if configured
    this.sidebarSwitcherEl.style.display = this.isPanelSwitcherHidden ? 'none' : ''

    // Switcher active state
    this.sidebarSwitcherEl.querySelectorAll('.awfy-app-sidebar-switcher-btn').forEach(btn => {
      const panel = (btn as HTMLElement).dataset.panel
      btn.classList.toggle('active', panel === this.activeSidebarPanel)
    })

    window.dispatchEvent(new Event('resize'))
  }

  private async loadChromeConfig() {
    let nextAgentSidebarHidden = false
    let nextSwitcherHidden = false
    let nextToggleHidden = false
    let nextStatusLineHidden = false
    let nextTabsHidden = false
    let nextTrafficLightsHidden = false
    try {
      const [agentSidebarValue, switcherValue, toggleValue, statusLineValue, tabsValue, trafficLightsValue] = await Promise.all([
        window.ipc?.getSetting(SystemConfigKeys.hideAgentSidebar),
        window.ipc?.getSetting(SystemConfigKeys.hidePanelSwitcher),
        window.ipc?.getSetting(SystemConfigKeys.hidePanelToggle),
        window.ipc?.getSetting(SystemConfigKeys.hideStatusLine),
        window.ipc?.getSetting(SystemConfigKeys.hideTabs),
        window.ipc?.getSetting(SystemConfigKeys.hideTrafficLights),
      ])
      nextAgentSidebarHidden = isTruthyConfig(agentSidebarValue)
      nextSwitcherHidden = isTruthyConfig(switcherValue)
      nextToggleHidden = isTruthyConfig(toggleValue)
      nextStatusLineHidden = isTruthyConfig(statusLineValue)
      nextTabsHidden = isTruthyConfig(tabsValue)
      nextTrafficLightsHidden = isTruthyConfig(trafficLightsValue)
    } catch {
      // ignore
    }
    if (
      nextAgentSidebarHidden === this.isAgentSidebarHidden
      && nextSwitcherHidden === this.isPanelSwitcherHidden
      && nextToggleHidden === this.isPanelToggleHidden
      && nextStatusLineHidden === this.isStatusLineHidden
      && nextTabsHidden === this.isTabsHidden
      && nextTrafficLightsHidden === this.isTrafficLightsHidden
    ) return
    this.isAgentSidebarHidden = nextAgentSidebarHidden
    this.isPanelSwitcherHidden = nextSwitcherHidden
    this.isPanelToggleHidden = nextToggleHidden
    this.isStatusLineHidden = nextStatusLineHidden
    this.isTabsHidden = nextTabsHidden
    this.isTrafficLightsHidden = nextTrafficLightsHidden
    document.documentElement.classList.toggle('traffic-lights-hidden', nextTrafficLightsHidden)
    this.updateSidebar()
  }

  private onConfigDbChanged = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key
    if (!key || !CHROME_CONFIG_KEYS.has(key)) return
    this.loadChromeConfig()
  }

  private onAgentSwitched = () => {
    this.loadChromeConfig()
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
      if (change.rowId == null) return

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
        window.dispatchEvent(new CustomEvent<{ key: string }>('agentwfy:config-db-changed', {
          detail: { key: String(change.rowId) },
        }))
      }
    })
  }
}
