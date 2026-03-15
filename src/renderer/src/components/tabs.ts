type TabDataType = 'view' | 'file' | 'url'

interface TabData {
  id: string
  type: TabDataType
  title: string
  // view: numeric/string view ID, file: relative path, url: full URL
  target: string | number
  viewUpdatedAt?: number | null    // only for view
  viewChanged: boolean             // only for view
  pinned: boolean
  hidden: boolean
  params?: Record<string, string>  // custom query params passed to the view
}

const PIN_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>`

const HIDDEN_TABS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

const TAB_TYPE_ICONS: Record<TabDataType, string> = {
  view: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  url: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
}

function extractParams(detail: Record<string, unknown>): Record<string, string> | undefined {
  const p = detail.params
  return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, string> : undefined
}

function generateId(len = 8): string {
  const arr = new Uint8Array((len || 40) / 2)
  window.crypto.getRandomValues(arr)
  return Array.from(arr, (v) => v.toString(16).padStart(2, '0')).join('')
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

  // Command palette / UI opens a view
  private onOpenView = (e: Event) => {
    const detail = (e as CustomEvent).detail
    const tabId = generateId()
    const viewId = typeof detail?.viewId !== 'undefined' ? detail.viewId : (detail?.path ?? null)
    if (viewId == null) return
    const params = extractParams(detail)
    const tab: TabData = {
      id: tabId,
      type: 'view',
      title: detail.title || 'Agent View',
      target: viewId,
      viewUpdatedAt: detail.viewUpdatedAt ?? null,
      viewChanged: false,
      pinned: false,
      hidden: false,
      params,
    }
    this.tabs = [...this.tabs, tab]
    this.selectedTabId = tabId
    this.render()
    this.dispatchTabSelected()
  }

  private onRemoveCurrentTab = () => {
    if (!this.selectedTabId) return
    const tab = this.tabs.find(t => t.id === this.selectedTabId)
    if (tab?.pinned) return
    this.removeTab(this.selectedTabId)
  }

  private onRefreshCurrentView = () => {
    if (!this.selectedTabId) return
    this.reloadTab(this.selectedTabId)
  }

  // Agent opens a tab (view, file, or url)
  private onAgentOpenTab = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (!detail) return

    let type: TabDataType
    let target: string | number

    if (detail.type === 'url' && typeof detail.url === 'string') {
      type = 'url'
      target = detail.url
    } else if (detail.type === 'file' && typeof detail.filePath === 'string') {
      type = 'file'
      target = detail.filePath
    } else if (typeof detail.viewId === 'string' || typeof detail.viewId === 'number') {
      type = 'view'
      target = detail.viewId
    } else {
      return
    }

    const tabId = generateId()
    const isHidden = Boolean(detail.hidden)
    const params = extractParams(detail)
    const tab: TabData = {
      id: tabId,
      type,
      title: detail.title || (type === 'url' ? 'Web Page' : type === 'file' ? 'File View' : 'Agent View'),
      target,
      viewUpdatedAt: null,
      viewChanged: false,
      pinned: false,
      hidden: isHidden,
      params,
    }
    this.tabs = [...this.tabs, tab]
    if (!isHidden) {
      this.selectedTabId = tabId
    }
    this.render()
    if (!isHidden) {
      this.dispatchTabSelected()
    }
  }

  private onAgentCloseTab = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (!detail || typeof detail.tabId !== 'string') return
    const tab = this.tabs.find(t => t.id === detail.tabId)
    if (!tab) return
    this.removeTab(detail.tabId)
  }

  private onAgentSelectTab = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (!detail || typeof detail.tabId !== 'string') return
    const tab = this.tabs.find(t => t.id === detail.tabId)
    if (!tab) return
    this.selectTab(detail.tabId)
  }

  private onAgentReloadTab = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (!detail || typeof detail.tabId !== 'string') return
    const tab = this.tabs.find(t => t.id === detail.tabId)
    if (!tab) return
    this.reloadTab(detail.tabId)
  }

  // Only view tabs track DB changes
  private onViewsDbChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail as { change?: { rowId?: unknown; op?: unknown } } | undefined
    const change = detail?.change
    if (!change || (change.op !== 'update' && change.op !== 'delete')) return
    if (typeof change.rowId !== 'string' && typeof change.rowId !== 'number') return

    if (this.markDbViewChanged(change.rowId)) {
      this.render()
    }
  }

  private markDbViewChanged(viewId: string | number): boolean {
    let changed = false
    for (const tab of this.tabs) {
      if (tab.type !== 'view' || tab.target != viewId) {
        continue
      }

      tab.viewChanged = true
      changed = true

      const viewEl = this.viewMap.get(tab.id) as (HTMLElement & { viewChanged?: boolean }) | undefined
      if (viewEl) {
        viewEl.viewChanged = true
      }
    }

    return changed
  }

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

    window.addEventListener('agentwfy:open-view', this.onOpenView)
    window.addEventListener('agentwfy:remove-current-tab', this.onRemoveCurrentTab)
    window.addEventListener('agentwfy:refresh-current-view', this.onRefreshCurrentView)
    window.addEventListener('agentwfy:views-db-changed', this.onViewsDbChanged)
    window.addEventListener('agentwfy:agent-open-tab', this.onAgentOpenTab)
    window.addEventListener('agentwfy:agent-close-tab', this.onAgentCloseTab)
    window.addEventListener('agentwfy:agent-select-tab', this.onAgentSelectTab)
    window.addEventListener('agentwfy:agent-reload-tab', this.onAgentReloadTab)

    this.render()
    this.openDefaultView()
  }

  private openDefaultView() {
    window.ipc?.getDefaultView().then(view => {
      if (view && this.tabs.length === 0) {
        window.dispatchEvent(new CustomEvent('agentwfy:open-view', { detail: view }))
      }
    }).catch(err => console.error('[openDefaultView]', err))
  }

  disconnectedCallback() {
    window.removeEventListener('agentwfy:open-view', this.onOpenView)
    window.removeEventListener('agentwfy:remove-current-tab', this.onRemoveCurrentTab)
    window.removeEventListener('agentwfy:refresh-current-view', this.onRefreshCurrentView)
    window.removeEventListener('agentwfy:views-db-changed', this.onViewsDbChanged)
    window.removeEventListener('agentwfy:agent-open-tab', this.onAgentOpenTab)
    window.removeEventListener('agentwfy:agent-close-tab', this.onAgentCloseTab)
    window.removeEventListener('agentwfy:agent-select-tab', this.onAgentSelectTab)
    window.removeEventListener('agentwfy:agent-reload-tab', this.onAgentReloadTab)
  }

  private selectTab(id: string) {
    this.selectedTabId = id
    this.render()
    this.dispatchTabSelected()
  }

  private removeTab(id: string) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab || tab.pinned) return

    // Clean up view element
    const viewEl = this.viewMap.get(id)
    if (viewEl) {
      viewEl.remove()
      this.viewMap.delete(id)
    }

    this.tabs = this.tabs.filter(t => t.id !== id)
    if (this.selectedTabId === id) {
      const visible = this.visibleTabs()
      const lastVisible = visible[visible.length - 1]
      this.selectedTabId = lastVisible?.id || null
    }
    this.render()
    this.dispatchTabSelected()
  }

  private togglePin(id: string) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab) return
    tab.pinned = !tab.pinned

    // Reorder: pinned tabs first, preserve relative order within each group
    const pinned = this.tabs.filter(t => t.pinned)
    const unpinned = this.tabs.filter(t => !t.pinned)
    this.tabs = [...pinned, ...unpinned]
    this.render()
  }

  private pinnedCount(): number {
    return this.tabs.filter(t => t.pinned && !t.hidden).length
  }

  private reorderTab(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return

    const pinnedEnd = this.pinnedCount()
    const fromPinned = fromIndex < pinnedEnd
    const toPinned = toIndex < pinnedEnd

    // Prevent dragging across the pinned/unpinned boundary
    if (fromPinned !== toPinned) return

    const newTabs = [...this.tabs]
    const [tab] = newTabs.splice(fromIndex, 1)
    newTabs.splice(toIndex, 0, tab)
    this.tabs = newTabs
    this.render()
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

  private revealTab(id: string) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab || !tab.hidden) return
    tab.hidden = false
    this.selectedTabId = id
    this.render()
    this.dispatchTabSelected()
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
      const pinnedEnd = visible.filter(t => t.pinned).length

      visible.forEach((tab, index) => {
        const tabItem = document.createElement('div')
        tabItem.className = 'tab-item'
        if (tab.id === this.selectedTabId) tabItem.classList.add('active')
        if (tab.pinned) tabItem.classList.add('pinned')
        tabItem.draggable = true

        // Drag handlers — use index within visible tabs for reorder
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
            this.reorderTab(this.dragFromIndex, realIndex)
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

        tabItem.addEventListener('click', () => this.selectTab(tab.id))
        tabItem.addEventListener('auxclick', (e) => {
          if (e.button === 1 && !tab.pinned) this.removeTab(tab.id)
        })

        // Context menu for pin/unpin
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
            this.removeTab(tab.id)
          })
          tabItem.appendChild(close)
        }

        tabBar.insertBefore(tabItem, this.hiddenTabsBtnEl)

        // Add separator after last pinned tab
        if (tab.pinned && index === pinnedEnd - 1 && pinnedEnd < visible.length) {
          const separator = document.createElement('div')
          separator.className = 'pinned-separator'
          tabBar.insertBefore(separator, this.hiddenTabsBtnEl)
        }
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
            this.removeTab(tab.id)
          })
          tabItem.appendChild(close)

          tabItem.addEventListener('click', () => this.revealTab(tab.id))
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
          viewEl.setAttribute('view-id', String(tab.target))
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
        if (viewEl.getAttribute('view-id') !== targetStr) {
          viewEl.setAttribute('view-id', targetStr)
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
    if (!ipc) {
      return
    }

    const action = await ipc.tabs.showContextMenu({
      x: e.clientX,
      y: e.clientY,
      pinned: Boolean(tab.pinned),
      viewChanged: Boolean(tab.viewChanged),
      tabId: tab.id,
    }).catch(() => null)

    if (action === 'toggle-pin') {
      this.togglePin(tab.id)
    } else if (action === 'reload') {
      this.reloadTab(tab.id)
    }
  }

  private reloadTab(id: string) {
    const tab = this.tabs.find(t => t.id === id)
    if (!tab) return
    tab.viewChanged = false
    const viewEl = this.viewMap.get(id) as (HTMLElement & { viewChanged?: boolean }) | undefined
    if (viewEl) {
      viewEl.viewChanged = false
    }
    window.dispatchEvent(new CustomEvent('agentwfy:refresh-view', {
      detail: { viewId: id }
    }))
    this.render()
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
        background: var(--color-bg3);
        flex-shrink: 0;
        min-height: 36px;
        align-items: flex-end;
        padding: 0 4px;
        gap: 2px;
        -webkit-app-region: drag;
        ${isWindows ? 'padding-right: 138px;' : ''}
      }
      .tab-bar::-webkit-scrollbar { display: none; }
      .tab-item {
        display: flex;
        align-items: center;
        padding: 6px 10px 6px 10px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 200px;
        flex-shrink: 0;
        gap: 6px;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        position: relative;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
      }
      .tab-item.pinned {
        max-width: none;
        padding: 6px 10px;
        justify-content: center;
      }
      .tab-item:hover {
        color: var(--color-text3);
        background: var(--color-bg2);
      }
      .tab-item.dragging { opacity: 0.4; }
      .tab-item.drag-over-left { box-shadow: inset 2px 0 0 var(--color-accent); }
      .tab-item.drag-over-right { box-shadow: inset -2px 0 0 var(--color-accent); }
      .tab-item.active {
        color: var(--color-text4);
        background: var(--color-bg1);
      }
      .tab-type-icon {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        width: 14px;
        height: 14px;
        opacity: 0.5;
        transition: opacity var(--transition-fast);
      }
      .tab-item.active .tab-type-icon {
        opacity: 0.8;
      }
      .tab-item:hover .tab-type-icon {
        opacity: 0.7;
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
        height: 16px;
        display: flex;
        align-items: center;
        opacity: 0.5;
      }
      .tab-item.active .tab-pin-icon {
        opacity: 0.8;
      }
      .tab-changed-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--color-accent);
        flex-shrink: 0;
      }
      .pinned-separator {
        width: 1px;
        background: var(--color-divider);
        margin: 6px 2px;
        flex-shrink: 0;
        align-self: stretch;
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
        color: var(--color-text2);
        font-size: 14px;
        -webkit-app-region: drag;
      }
      .hidden-tabs-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 8px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 11px;
        white-space: nowrap;
        flex-shrink: 0;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        margin-left: auto;
      }
      .hidden-tabs-btn:hover {
        color: var(--color-text3);
        background: var(--color-bg2);
      }
      .hidden-tabs-btn.active {
        color: var(--color-text4);
        background: var(--color-bg2);
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
        margin: 6px 2px;
        flex-shrink: 0;
        align-self: stretch;
      }
      .hidden-tab-item {
        display: flex;
        align-items: center;
        padding: 6px 10px;
        cursor: pointer;
        color: var(--color-text2);
        font-size: 12px;
        white-space: nowrap;
        max-width: 200px;
        flex-shrink: 0;
        gap: 6px;
        border-radius: var(--radius-sm) var(--radius-sm) 0 0;
        transition: color var(--transition-fast), background var(--transition-fast);
        -webkit-app-region: no-drag;
        opacity: 0.6;
        border-bottom: 1px dashed var(--color-divider);
      }
      .hidden-tab-item:hover {
        opacity: 1;
        color: var(--color-text3);
        background: var(--color-bg2);
      }
      .hidden-tab-item:hover .tab-close { opacity: 1; }
    `
  }
}
