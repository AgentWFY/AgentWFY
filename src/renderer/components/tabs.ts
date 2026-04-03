import type { TabData, TabDataType, TabState } from '../ipc-types/index.js'

const PIN_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`

const HIDDEN_TABS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

const TAB_TYPE_ICONS: Record<TabDataType, string> = {
  view: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  url: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
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

    this.render()
  }

  disconnectedCallback() {
    if (this.unsubscribeStateChanged) {
      this.unsubscribeStateChanged()
      this.unsubscribeStateChanged = null
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

    if (!hasVisibleTabs && !this.hiddenTabsExpanded) {
      // Still need to manage panels for hidden tabs below
    } else {
      const tabBar = this.tabBarEl

      visible.forEach((tab) => {
        const tabItem = document.createElement('div')
        tabItem.className = 'tab-item'
        if (tab.id === this.selectedTabId) tabItem.classList.add('active')
        if (tab.pinned) tabItem.classList.add('pinned')
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

          // Check boundary constraint before showing indicators
          const fromPinned = this.dragFromIndex !== null && this.tabs[this.dragFromIndex]?.pinned === true
          const toPinned = tab.pinned
          if (this.dragFromIndex !== null && fromPinned !== toPinned) {
            e.dataTransfer!.dropEffect = 'none'
            return
          }

          // Remove old drag-over classes
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

        if (tab.pinned) {
          const pin = document.createElement('span')
          pin.className = 'tab-pin-icon'
          pin.innerHTML = PIN_ICON_SVG
          tabItem.appendChild(pin)
          if (tab.viewChanged) {
            const dot = document.createElement('span')
            dot.className = 'tab-changed-dot'
            tabItem.appendChild(dot)
          }
        } else {
          const icon = document.createElement('span')
          icon.className = 'tab-type-icon'
          icon.innerHTML = TAB_TYPE_ICONS[tab.type]
          tabItem.appendChild(icon)

          const title = document.createElement('span')
          title.className = 'tab-title'
          title.textContent = tab.title
          tabItem.appendChild(title)

          if (tab.viewChanged) {
            const dot = document.createElement('span')
            dot.className = 'tab-changed-dot'
            tabItem.appendChild(dot)
          }

          const close = document.createElement('span')
          close.className = 'tab-close'
          close.textContent = '\u00d7'
          close.addEventListener('click', (e) => {
            e.stopPropagation()
            window.ipc?.tabs.closeTab({ tabId: tab.id })
          })
          tabItem.appendChild(close)
        }

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

          const icon = document.createElement('span')
          icon.className = 'tab-type-icon'
          icon.innerHTML = TAB_TYPE_ICONS[tab.type]
          tabItem.appendChild(icon)

          const title = document.createElement('span')
          title.className = 'tab-title'
          title.textContent = tab.title
          tabItem.appendChild(title)

          const close = document.createElement('span')
          close.className = 'tab-close'
          close.textContent = '\u00d7'
          close.addEventListener('click', (e) => {
            e.stopPropagation()
            window.ipc?.tabs.closeTab({ tabId: tab.id })
          })
          tabItem.appendChild(close)

          tabItem.addEventListener('click', () => {
            window.ipc?.tabs.revealTab(tab.id)
          })
          tabBar.appendChild(tabItem)
        }
      }
    }

    const activeIds = new Set(this.tabs.map((tab) => tab.id))
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

    for (const [id, panel] of this.panelMap) {
      if (!activeIds.has(id)) {
        panel.remove()
        this.panelMap.delete(id)
      }
    }

    // Clean up view elements for removed tabs
    for (const [id, el] of this.viewMap) {
      if (!activeIds.has(id)) {
        el.remove()
        this.viewMap.delete(id)
      }
    }
  }

  private async showTabContextMenu(e: MouseEvent, tab: TabData) {
    const ipc = window.ipc
    if (!ipc) return

    // Main process shows the menu and executes the action directly
    await ipc.tabs.showContextMenu({
      x: e.clientX,
      y: e.clientY,
      pinned: Boolean(tab.pinned),
      viewChanged: Boolean(tab.viewChanged),
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
        align-items: center;
        padding: 0 4px;
        gap: 4px;
        -webkit-app-region: drag;
        ${isWindows ? 'padding-right: 138px;' : ''}
      }
      .tab-bar::-webkit-scrollbar { display: none; }
      .tab-item {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 200px;
        flex-shrink: 0;
        border-radius: var(--radius-md);
        position: relative;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        background: transparent;
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
        box-shadow: 0 0 2px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04);
      }
      .tab-type-icon {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        opacity: 0.45;
        transition: opacity var(--transition-fast);
      }
      .tab-item.active .tab-type-icon {
        opacity: 0.75;
      }
      .tab-item:hover .tab-type-icon {
        opacity: 0.65;
      }
      .tab-title {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tab-close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: var(--radius-sm);
        font-size: 14px;
        line-height: 1;
        color: var(--color-text2);
        opacity: 0;
        flex-shrink: 0;
        cursor: pointer;
        margin-right: -4px;
        transition: opacity var(--transition-fast), background var(--transition-fast);
      }
      .tab-close:hover {
        background: var(--color-item-hover);
        color: var(--color-text4);
      }
      .tab-item:hover .tab-close,
      .tab-item.active .tab-close { opacity: 1; }
      .tab-pin-icon {
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        display: flex;
        align-items: center;
        opacity: 0.5;
      }
      .tab-item.active .tab-pin-icon {
        opacity: 0.85;
      }
      .tab-item:hover .tab-pin-icon {
        opacity: 0.7;
      }
      .tab-changed-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-accent);
        flex-shrink: 0;
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
        gap: 4px;
        padding: 0 8px;
        height: 28px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 11px;
        white-space: nowrap;
        flex-shrink: 0;
        border-radius: var(--radius-md);
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
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 8px;
        background: var(--color-accent);
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        line-height: 1;
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
        height: 28px;
        padding: 0 10px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 200px;
        flex-shrink: 0;
        gap: 6px;
        border-radius: var(--radius-md);
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        opacity: 0.6;
      }
      .hidden-tab-item:hover {
        opacity: 1;
        color: var(--color-text3);
        background: var(--color-item-hover);
      }
      .hidden-tab-item:hover .tab-close { opacity: 1; }
    `
  }
}