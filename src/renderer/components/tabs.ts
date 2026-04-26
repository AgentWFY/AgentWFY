import type { TabData, TabState } from '../ipc-types/index.js'

const PIN_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`

const HIDDEN_TABS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

function formatTarget(tab: TabData): string {
  if (tab.type === 'url') {
    try {
      const u = new URL(tab.target)
      const host = u.host.replace(/^www\./, '')
      const path = u.pathname === '/' ? '' : u.pathname
      const search = u.search || ''
      return host + path + search
    } catch {
      return tab.target
    }
  }
  return tab.target
}

export class TlTabs extends HTMLElement {
  tabs: TabData[] = []
  selectedTabId: string | null = null

  private dragFromIndex: number | null = null
  private dragOverIndex: number | null = null
  private containerEl!: HTMLDivElement
  tabBarEl!: HTMLDivElement
  private panelContainerEl!: HTMLDivElement
  private emptyStateEl!: HTMLDivElement
  private viewMap: Map<string, HTMLElement> = new Map()
  private panelMap: Map<string, HTMLDivElement> = new Map()

  private styleEl!: HTMLStyleElement
  private hiddenTabsBtnEl!: HTMLDivElement
  private hiddenTabsExpanded = false
  private unsubscribeStateChanged: (() => void) | null = null
  private unsubscribeSettingChanged: (() => void) | null = null
  private lastDispatchedSelectedTabId: string | null = null

  connectedCallback() {
    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = '100%'
    this.style.minHeight = '0'
    this.style.minWidth = '0'

    this.styleEl = document.createElement('style')
    this.styleEl.textContent = this.getStyles()
    this.appendChild(this.styleEl)

    this.containerEl = document.createElement('div')
    this.containerEl.className = 'tabs-container'

    this.tabBarEl = document.createElement('div')
    this.tabBarEl.className = 'tab-bar'

    this.hiddenTabsBtnEl = document.createElement('div')
    this.hiddenTabsBtnEl.className = 'hidden-tabs-btn'
    this.hiddenTabsBtnEl.style.display = 'none'
    this.hiddenTabsBtnEl.addEventListener('click', () => {
      this.hiddenTabsExpanded = !this.hiddenTabsExpanded
      this.render()
    })

    this.tabBarEl.appendChild(this.hiddenTabsBtnEl)

    this.panelContainerEl = document.createElement('div')
    this.panelContainerEl.className = 'tab-panel-container'

    this.emptyStateEl = document.createElement('div')
    this.emptyStateEl.className = 'empty-state'
    this.emptyStateEl.textContent = 'No open tabs'

    this.containerEl.appendChild(this.tabBarEl)
    this.containerEl.appendChild(this.panelContainerEl)
    this.containerEl.appendChild(this.emptyStateEl)
    this.appendChild(this.containerEl)

    // Subscribe to tab state pushes from main process
    const ipc = window.ipc
    if (ipc) {
      this.unsubscribeStateChanged = ipc.tabs.onStateChanged((state: TabState) => {
        this.applyState(state)
      })

      // Fetch initial state
      ipc.tabs.getTabState().then((state: TabState) => {
        this.applyState(state)
      }).catch(err => console.error('[tabs] getTabState failed:', err))
    }

    // Load tab-source config flag and react to changes from anywhere
    void this.loadConfig()
    window.addEventListener('agentwfy:config-db-changed', this.onConfigDbChanged)
    if (ipc) {
      this.unsubscribeSettingChanged = ipc.onSettingChanged(({ key }) => {
        if (key !== 'system.show-tab-source') return
        void this.loadConfig()
      })
    }

    this.render()
  }

  disconnectedCallback() {
    if (this.unsubscribeStateChanged) {
      this.unsubscribeStateChanged()
      this.unsubscribeStateChanged = null
    }
    if (this.unsubscribeSettingChanged) {
      this.unsubscribeSettingChanged()
      this.unsubscribeSettingChanged = null
    }
    window.removeEventListener('agentwfy:config-db-changed', this.onConfigDbChanged)
    document.documentElement.classList.remove('tabs-show-source')
  }

  private onConfigDbChanged = (e: Event) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key
    if (key && key !== 'system.show-tab-source') return
    void this.loadConfig()
  }

  private async loadConfig() {
    const ipc = window.ipc
    if (!ipc) return
    try {
      const value = await ipc.getSetting('system.show-tab-source')
      const v = String(value ?? '').toLowerCase()
      const next = v === '' ? true : !(v === 'false' || v === '0' || v === 'no')
      document.documentElement.classList.toggle('tabs-show-source', next)
    } catch {
      // ignore
    }
  }

  private applyState(state: TabState) {
    this.tabs = state.tabs
    this.selectedTabId = state.selectedTabId
    this.render()
    if (this.selectedTabId !== this.lastDispatchedSelectedTabId) {
      this.lastDispatchedSelectedTabId = this.selectedTabId
      this.dispatchTabSelected()
    }
  }

  private dispatchTabSelected() {
    const tab = this.tabs.find(t => t.id === this.selectedTabId) || null
    window.dispatchEvent(new CustomEvent('agentwfy:tab-selected', {
      detail: { tab }
    }))
  }

  private hiddenTabs(): TabData[] {
    return this.tabs.filter(t => t.hidden)
  }

  private visibleTabs(): TabData[] {
    return this.tabs.filter(t => !t.hidden)
  }

  /** Build the inner DOM of a tab item. Pinned tabs render only the pin icon. */
  private buildTabItemBody(tabItem: HTMLDivElement, tab: TabData) {
    if (tab.pinned) {
      const pin = document.createElement('span')
      pin.className = 'tab-pin-icon'
      pin.innerHTML = PIN_ICON_SVG
      tabItem.appendChild(pin)
      return
    }

    const row = document.createElement('div')
    row.className = 'tab-row'

    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = tab.title
    row.appendChild(title)

    const status = document.createElement('span')
    status.className = 'tab-status'

    const dot = document.createElement('span')
    dot.className = 'tab-status-dot'
    status.appendChild(dot)

    const close = document.createElement('span')
    close.className = 'tab-close'
    close.textContent = '\u00d7'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      window.ipc?.tabs.closeTab({ tabId: tab.id })
    })
    status.appendChild(close)

    row.appendChild(status)
    tabItem.appendChild(row)

    const target = document.createElement('span')
    target.className = 'tab-target'
    target.textContent = formatTarget(tab)
    tabItem.appendChild(target)
  }

  private render() {
    if (!this.containerEl) return

    const visible = this.visibleTabs()
    const hasVisibleTabs = visible.length > 0
    this.panelContainerEl.style.display = hasVisibleTabs ? 'flex' : 'none'
    this.emptyStateEl.style.display = hasVisibleTabs ? 'none' : 'flex'

    const oldTabItems = this.tabBarEl.querySelectorAll('.tab-item, .pinned-separator, .hidden-separator, .hidden-tab-item')
    oldTabItems.forEach(el => el.remove())

    // Update hidden tabs toggle button
    const hidden = this.hiddenTabs()
    if (hidden.length > 0) {
      this.hiddenTabsBtnEl.innerHTML = `${HIDDEN_TABS_ICON}<span class="hidden-tabs-count">${hidden.length}</span>`
      this.hiddenTabsBtnEl.style.display = ''
      this.hiddenTabsBtnEl.classList.toggle('active', this.hiddenTabsExpanded)
    } else {
      this.hiddenTabsBtnEl.style.display = 'none'
      this.hiddenTabsExpanded = false
    }

    if (hasVisibleTabs || this.hiddenTabsExpanded) {
      const tabBar = this.tabBarEl

      visible.forEach((tab) => {
        const tabItem = document.createElement('div')
        tabItem.className = 'tab-item'
        if (tab.id === this.selectedTabId) tabItem.classList.add('active')
        if (tab.pinned) tabItem.classList.add('pinned')
        if (tab.viewChanged) tabItem.classList.add('changed')
        tabItem.draggable = true

        // Drag handlers — use index within all tabs for reorder
        const realIndex = this.tabs.indexOf(tab)
        tabItem.addEventListener('dragstart', (e) => {
          this.dragFromIndex = realIndex
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', String(realIndex))
          }
          tabItem.classList.add('dragging')
        })

        tabItem.addEventListener('dragover', (e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

          const fromPinned = this.dragFromIndex !== null && this.tabs[this.dragFromIndex]?.pinned === true
          const toPinned = tab.pinned
          if (this.dragFromIndex !== null && fromPinned !== toPinned) {
            e.dataTransfer!.dropEffect = 'none'
            return
          }

          tabBar.querySelectorAll('.drag-over-left, .drag-over-right').forEach(el => {
            el.classList.remove('drag-over-left', 'drag-over-right')
          })
          if (this.dragFromIndex !== null && this.dragFromIndex !== realIndex) {
            if (this.dragFromIndex > realIndex) {
              tabItem.classList.add('drag-over-left')
            } else {
              tabItem.classList.add('drag-over-right')
            }
          }
          this.dragOverIndex = realIndex
        })

        tabItem.addEventListener('dragleave', () => {
          tabItem.classList.remove('drag-over-left', 'drag-over-right')
          if (this.dragOverIndex === realIndex) this.dragOverIndex = null
        })

        tabItem.addEventListener('drop', (e) => {
          e.preventDefault()
          if (this.dragFromIndex !== null && this.dragFromIndex !== realIndex) {
            window.ipc?.tabs.reorderTabs(this.dragFromIndex, realIndex)
          }
          this.dragFromIndex = null
          this.dragOverIndex = null
        })

        tabItem.addEventListener('dragend', () => {
          this.dragFromIndex = null
          this.dragOverIndex = null
          tabBar.querySelectorAll('.dragging, .drag-over-left, .drag-over-right').forEach(el => {
            el.classList.remove('dragging', 'drag-over-left', 'drag-over-right')
          })
        })

        tabItem.addEventListener('click', () => {
          window.ipc?.tabs.selectTab({ tabId: tab.id })
        })
        tabItem.addEventListener('auxclick', (e) => {
          if (e.button === 1 && !tab.pinned) {
            window.ipc?.tabs.closeTab({ tabId: tab.id })
          }
        })

        // Context menu for pin/unpin (main process handles the action)
        tabItem.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          void this.showTabContextMenu(e, tab)
        })

        this.buildTabItemBody(tabItem, tab)

        tabBar.insertBefore(tabItem, this.hiddenTabsBtnEl)
      })

      // Render expanded hidden tabs inline after the toggle button
      if (this.hiddenTabsExpanded && hidden.length > 0) {
        const sep = document.createElement('div')
        sep.className = 'hidden-separator'
        tabBar.appendChild(sep)

        for (const tab of hidden) {
          const tabItem = document.createElement('div')
          tabItem.className = 'hidden-tab-item'
          if (tab.viewChanged) tabItem.classList.add('changed')

          this.buildTabItemBody(tabItem, tab)

          tabItem.addEventListener('click', () => {
            window.ipc?.tabs.revealTab(tab.id)
          })
          tabBar.appendChild(tabItem)
        }
      }
    }

    const activeIds = new Set(this.tabs.map((tab) => tab.id))

    // Clean up panels/views for removed tabs BEFORE reordering, so stale
    // DOM children don't cause unnecessary insertBefore moves that trigger
    // awfy-tab-view disconnect/connect lifecycle (which reloads the view).
    for (const [id, panel] of this.panelMap) {
      if (!activeIds.has(id)) {
        panel.remove()
        this.panelMap.delete(id)
      }
    }
    for (const [id, el] of this.viewMap) {
      if (!activeIds.has(id)) {
        el.remove()
        this.viewMap.delete(id)
      }
    }

    this.tabs.forEach((tab, index) => {
      let panel = this.panelMap.get(tab.id)
      if (!panel) {
        panel = document.createElement('div')
        panel.className = 'tab-panel'
        this.panelMap.set(tab.id, panel)
      }
      // Hidden tabs are always display:none; visible tabs show only when selected
      panel.style.display = tab.hidden ? 'none' : (tab.id === this.selectedTabId ? '' : 'none')

      // All tab types use <awfy-tab-view> with different attributes
      let viewEl = this.viewMap.get(tab.id)
      if (!viewEl) {
        viewEl = document.createElement('awfy-tab-view')
        viewEl.setAttribute('tab-id', tab.id)
        viewEl.setAttribute('tab-type', tab.type)
        if (tab.hidden) {
          viewEl.setAttribute('hidden-tab', '')
        }
        if (tab.type === 'view') {
          viewEl.setAttribute('view-name', String(tab.target))
          viewEl.setAttribute('view-updated-at', tab.viewUpdatedAt == null ? '' : String(tab.viewUpdatedAt))
        } else if (tab.type === 'file') {
          viewEl.setAttribute('view-path', String(tab.target))
        } else if (tab.type === 'url') {
          viewEl.setAttribute('view-url', String(tab.target))
        }
        if (tab.params) {
          viewEl.setAttribute('view-params', JSON.stringify(tab.params))
        }
        const tabViewEl1 = viewEl as HTMLElement & { viewChanged?: boolean }
        tabViewEl1.viewChanged = tab.viewChanged
        this.viewMap.set(tab.id, viewEl)
      }

      // Sync hidden-tab attribute
      if (tab.hidden && !viewEl.hasAttribute('hidden-tab')) {
        viewEl.setAttribute('hidden-tab', '')
      } else if (!tab.hidden && viewEl.hasAttribute('hidden-tab')) {
        viewEl.removeAttribute('hidden-tab')
      }

      // Sync attributes for view tabs
      if (tab.type === 'view') {
        const targetStr = String(tab.target)
        if (viewEl.getAttribute('view-name') !== targetStr) {
          viewEl.setAttribute('view-name', targetStr)
        }
        const updatedAtStr = tab.viewUpdatedAt == null ? '' : String(tab.viewUpdatedAt)
        if (viewEl.getAttribute('view-updated-at') !== updatedAtStr) {
          viewEl.setAttribute('view-updated-at', updatedAtStr)
        }
      }

      const tabViewEl2 = viewEl as HTMLElement & { viewChanged?: boolean }
      tabViewEl2.viewChanged = tab.viewChanged
      if (panel.firstElementChild !== viewEl || panel.childElementCount !== 1) {
        panel.replaceChildren(viewEl)
      }

      const panelAtIndex = this.panelContainerEl.children[index]
      if (panelAtIndex !== panel) {
        this.panelContainerEl.insertBefore(panel, panelAtIndex || null)
      }
    })

  }

  private async showTabContextMenu(e: MouseEvent, tab: TabData) {
    const ipc = window.ipc
    if (!ipc) return

    // Main process shows the menu and executes the action directly
    await ipc.tabs.showContextMenu({
      x: e.clientX,
      y: e.clientY,
      tabId: tab.id,
    }).catch(() => null)
  }

  private getStyles(): string {
    const isWindows = navigator.platform.includes('Win')
    return `
      .tabs-container {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;
        min-height: 0;
        min-width: 0;
      }
      .tab-bar {
        display: flex;
        overflow-x: auto;
        flex-shrink: 0;
        align-self: stretch;
        align-items: stretch;
        padding: 0;
        gap: 0;
        -webkit-app-region: drag;
        ${isWindows ? 'padding-right: 138px;' : ''}
      }
      .tab-bar::-webkit-scrollbar { display: none; }

      /* Compact (single-line) is the default — flat segments with dividers */
      .tab-item {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        align-self: stretch;
        padding: 0 12px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 220px;
        flex-shrink: 0;
        border-right: 1px solid var(--color-divider);
        position: relative;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        background: transparent;
      }
      .tab-item:first-child {
        border-left: 1px solid var(--color-divider);
      }
      .tab-item.pinned {
        max-width: none;
        width: 28px;
        padding: 0;
      }
      .tab-item:hover {
        color: var(--color-text3);
        background: var(--color-item-hover);
      }
      .tab-item.dragging { opacity: 0.4; }
      .tab-item.drag-over-left { box-shadow: inset 2px 0 0 var(--color-accent); }
      .tab-item.drag-over-right { box-shadow: inset -2px 0 0 var(--color-accent); }
      .tab-item.active {
        color: var(--color-text4);
        background: var(--color-bg1);
        font-weight: 500;
      }

      .tab-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .tab-title {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Status slot — close × OR changed dot, mutually exclusive */
      .tab-status {
        position: relative;
        flex: 0 0 14px;
        width: 14px;
        height: 14px;
        display: grid;
        place-items: center;
        margin-right: -4px;
      }
      .tab-status-dot {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-accent);
        opacity: 0;
        transition: opacity var(--transition-fast);
      }
      .tab-close {
        position: relative;
        display: grid;
        place-items: center;
        width: 14px;
        height: 14px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        line-height: 1;
        color: var(--color-text2);
        opacity: 0;
        cursor: pointer;
        transition: opacity var(--transition-fast), background var(--transition-fast);
      }
      .tab-close:hover {
        background: var(--color-item-hover);
        color: var(--color-text4);
        opacity: 1;
      }

      /* Status priority: hover > changed > active-without-changes > nothing */
      .tab-item.changed:not(:hover) .tab-status-dot { opacity: 1; }
      .tab-item.active:not(.changed):not(:hover) .tab-close { opacity: 0.8; }
      .tab-item:hover .tab-close { opacity: 0.8; }
      .tab-item:hover .tab-status-dot { opacity: 0; }

      /* Pinned tabs hide the status slot; the changed indicator is a corner badge */
      .tab-item.pinned .tab-status,
      .tab-item.pinned .tab-target,
      .tab-item.pinned .tab-row { display: none; }
      .tab-item.pinned.changed::after {
        content: '';
        position: absolute;
        top: 4px;
        right: 4px;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--color-accent);
      }

      .tab-pin-icon {
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.5;
      }
      .tab-item.active .tab-pin-icon { opacity: 0.85; }
      .tab-item:hover .tab-pin-icon { opacity: 0.7; }

      /* Source target line — hidden by default, shown when show-source is on */
      .tab-target {
        display: none;
        font-family: var(--font-mono);
        font-size: 10px;
        line-height: 12px;
        color: var(--color-text1);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      /* Show-source mode: two-line tabs. flex: 0 1 auto + min-width
         keeps tabs at content size when there's room (so a single tab
         doesn't stretch the bar) while still letting them shrink when
         crowded. */
      :root.tabs-show-source .tab-item:not(.pinned),
      :root.tabs-show-source .hidden-tab-item {
        flex-direction: column;
        justify-content: center;
        align-items: stretch;
        gap: 1px;
        padding: 4px 12px;
        max-width: 320px;
        flex: 0 1 auto;
        min-width: 80px;
      }
      :root.tabs-show-source .tab-target {
        display: block;
      }
      :root.tabs-show-source .tab-item.active .tab-target {
        color: var(--color-text2);
      }

      .tab-panel-container {
        flex: 1;
        overflow: hidden;
        min-height: 0;
        min-width: 0;
        display: flex;
        background: var(--color-bg1);
      }
      .tab-panel {
        flex: 1;
        height: 100%;
        overflow: hidden;
        min-height: 0;
        min-width: 0;
      }
      .tab-panel > awfy-tab-view {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 0;
      }
      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        background: var(--color-bg2);
        color: var(--color-text2);
        font-size: 14px;
        -webkit-app-region: drag;
      }
      .hidden-tabs-btn {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 0 10px;
        align-self: stretch;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 11px;
        white-space: nowrap;
        flex-shrink: 0;
        border-left: 1px solid var(--color-divider);
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        margin-left: auto;
      }
      .hidden-tabs-btn:hover {
        color: var(--color-text3);
        background: var(--color-item-hover);
      }
      .hidden-tabs-btn.active {
        color: var(--color-text4);
        background: var(--color-item-hover);
      }
      .hidden-tabs-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 14px;
        height: 14px;
        padding: 0 4px;
        border-radius: 7px;
        background: var(--color-bg3);
        color: var(--color-text3);
        font-size: 10px;
        font-weight: 600;
        line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .hidden-tabs-btn.active .hidden-tabs-count {
        background: var(--color-text4);
        color: var(--color-bg1);
      }
      .hidden-separator {
        width: 1px;
        background: var(--color-divider);
        margin: 0 2px;
        flex-shrink: 0;
        height: 14px;
        align-self: center;
      }
      .hidden-tab-item {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        align-self: stretch;
        padding: 0 12px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 220px;
        flex-shrink: 0;
        border-right: 1px solid var(--color-divider);
        position: relative;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        background: transparent;
        opacity: 0.6;
      }
      .hidden-tab-item:hover {
        opacity: 1;
        color: var(--color-text3);
        background: var(--color-item-hover);
      }
      /* Hidden tabs reuse the same status-slot rules */
      .hidden-tab-item.changed:not(:hover) .tab-status-dot { opacity: 1; }
      .hidden-tab-item:hover .tab-close { opacity: 0.8; }
      .hidden-tab-item:hover .tab-status-dot { opacity: 0; }
    `
  }
}
