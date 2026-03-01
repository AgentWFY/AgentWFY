import type {
  ElectronTabViewBounds,
  ElectronTabViewEvent,
  ElectronMountTabViewRequest,
} from '../electron_agent_tools'

type TabType = 'view' | 'file' | 'url'

export class TlTabView extends HTMLElement {
  private _tabId = ''
  private _tabType: TabType = 'view'
  private _source = ''  // viewId for view, filePath for file, url for url
  private _viewUpdatedAt: number | null = null
  private _viewChanged = false
  private loadRequestId = 0
  private loading = false
  private error: string | null = null
  private wrapperEl: HTMLDivElement | null = null
  private loadingEl: HTMLDivElement | null = null
  private errorEl: HTMLDivElement | null = null
  private containerEl: HTMLDivElement | null = null
  private viewRevision = 0
  private mounted = false
  private pendingLoadSource: string | null = null
  private pendingLoadAnimationFrame: number | null = null
  private pendingBoundsAnimationFrame: number | null = null
  private wrapperResizeObserver: ResizeObserver | null = null
  private parentVisibilityObserver: MutationObserver | null = null
  private unsubscribeTabViewEvents: (() => void) | null = null
  private onRefreshView = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail.viewId === this._tabId) {
      this.handleReload()
    }
  }

  private onWindowOrVisibilityChanged = () => {
    this.scheduleBoundsSync()

    if (!this.mounted && this._source) {
      this.scheduleLoad(this._source)
    }
  }

  static get observedAttributes() {
    return ['tab-id', 'tab-type', 'view-id', 'view-path', 'view-url', 'view-updated-at']
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null) {
    const nextValue = value || ''
    if (name === 'tab-id') this._tabId = nextValue
    if (name === 'tab-type') this._tabType = (nextValue as TabType) || 'view'
    if (name === 'view-id') this._source = nextValue
    if (name === 'view-path' && !this.hasAttribute('view-id')) this._source = nextValue
    if (name === 'view-url' && !this.hasAttribute('view-id') && !this.hasAttribute('view-path')) this._source = nextValue
    if (name === 'view-updated-at') this._viewUpdatedAt = parseOptionalNumber(value)

    if (!this.isConnected || oldValue === nextValue) return

    if (name === 'view-id' || name === 'view-path' || name === 'view-url' || name === 'view-updated-at') {
      this._viewChanged = false
      this.mounted = false

      if (this._source) {
        this.scheduleLoad(this._source)
        this.scheduleBoundsSync()
      } else {
        this.loadRequestId += 1
        this.loading = false
        this.error = null
        this.pendingLoadSource = null
        if (this.pendingLoadAnimationFrame !== null) {
          cancelAnimationFrame(this.pendingLoadAnimationFrame)
          this.pendingLoadAnimationFrame = null
        }
        this.destroyTabViewHost()
        this.render()
      }
    }
  }

  get tabId() { return this._tabId }
  get viewId() { return this._source }

  get viewChanged() { return this._viewChanged }
  set viewChanged(value: boolean) {
    this._viewChanged = value
    this.render()
  }

  connectedCallback() {
    this._tabId = this.getAttribute('tab-id') || ''
    this._tabType = (this.getAttribute('tab-type') as TabType) || 'view'
    this._source = this.getAttribute('view-id') || this.getAttribute('view-path') || this.getAttribute('view-url') || ''
    this._viewUpdatedAt = parseOptionalNumber(this.getAttribute('view-updated-at'))

    this.style.display = 'block'
    this.style.width = '100%'
    this.style.height = '100%'
    this.style.minHeight = '0'
    this.style.minWidth = '0'

    if (!this.containerEl) {
      this.initializeUi()
    }

    if (this.containerEl && this.containerEl.parentElement !== this) {
      this.appendChild(this.containerEl)
    }

    this.attachParentVisibilityObserver()
    this.subscribeToTabViewEvents()

    window.addEventListener('agentwfy:refresh-view', this.onRefreshView)
    window.addEventListener('resize', this.onWindowOrVisibilityChanged)
    document.addEventListener('visibilitychange', this.onWindowOrVisibilityChanged)

    this.render()

    if (this._source) {
      this.scheduleLoad(this._source)
      this.scheduleBoundsSync()
    }
  }

  disconnectedCallback() {
    this.loadRequestId += 1
    this.loading = false
    this.pendingLoadSource = null

    if (this.pendingLoadAnimationFrame !== null) {
      cancelAnimationFrame(this.pendingLoadAnimationFrame)
      this.pendingLoadAnimationFrame = null
    }

    if (this.pendingBoundsAnimationFrame !== null) {
      cancelAnimationFrame(this.pendingBoundsAnimationFrame)
      this.pendingBoundsAnimationFrame = null
    }

    if (this.wrapperResizeObserver) {
      this.wrapperResizeObserver.disconnect()
      this.wrapperResizeObserver = null
    }

    if (this.parentVisibilityObserver) {
      this.parentVisibilityObserver.disconnect()
      this.parentVisibilityObserver = null
    }

    if (this.unsubscribeTabViewEvents) {
      this.unsubscribeTabViewEvents()
      this.unsubscribeTabViewEvents = null
    }

    window.removeEventListener('agentwfy:refresh-view', this.onRefreshView)
    window.removeEventListener('resize', this.onWindowOrVisibilityChanged)
    document.removeEventListener('visibilitychange', this.onWindowOrVisibilityChanged)

    this.destroyTabViewHost()
  }

  private initializeUi() {
    this.containerEl = document.createElement('div')
    this.containerEl.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;'

    this.wrapperEl = document.createElement('div')
    this.wrapperEl.style.cssText = 'flex:1;width:100%;min-height:0;overflow:hidden;position:relative;'

    this.loadingEl = document.createElement('div')
    this.loadingEl.style.cssText = 'display:none;align-items:center;justify-content:center;padding:12px;'
    const spinner = document.createElement('div')
    spinner.style.cssText = 'width:32px;height:32px;border:3px solid var(--color-border, #ccc);border-top-color:var(--color-accent, #0078d4);border-radius:50%;animation:tl-spin 0.8s linear infinite;'
    if (!document.getElementById('tl-spin-keyframes')) {
      const style = document.createElement('style')
      style.id = 'tl-spin-keyframes'
      style.textContent = '@keyframes tl-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(style)
    }
    this.loadingEl.appendChild(spinner)

    this.errorEl = document.createElement('div')
    this.errorEl.style.cssText = 'display:none;padding:16px;border:2px solid red;color:red;font-family:monospace;'

    this.containerEl.appendChild(this.wrapperEl)
    this.containerEl.appendChild(this.loadingEl)
    this.containerEl.appendChild(this.errorEl)

    this.wrapperResizeObserver = new ResizeObserver(() => {
      this.scheduleBoundsSync()

      if (!this.mounted && this._source) {
        this.scheduleLoad(this._source)
      }
    })
    this.wrapperResizeObserver.observe(this.wrapperEl)
  }

  private attachParentVisibilityObserver() {
    if (this.parentVisibilityObserver) {
      this.parentVisibilityObserver.disconnect()
      this.parentVisibilityObserver = null
    }

    const parent = this.parentElement
    if (!parent) {
      return
    }

    this.parentVisibilityObserver = new MutationObserver(() => {
      this.scheduleBoundsSync()

      if (!this.mounted && this._source) {
        this.scheduleLoad(this._source)
      }
    })

    this.parentVisibilityObserver.observe(parent, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
  }

  private subscribeToTabViewEvents() {
    const tools = window.electronClientTools
    if (!tools || typeof tools.onTabViewEvent !== 'function') {
      return
    }

    if (this.unsubscribeTabViewEvents) {
      this.unsubscribeTabViewEvents()
      this.unsubscribeTabViewEvents = null
    }

    this.unsubscribeTabViewEvents = tools.onTabViewEvent((detail: ElectronTabViewEvent) => {
      if (!detail || detail.tabId !== this.getExternalTabId()) {
        return
      }

      if (detail.type === 'did-start-loading') {
        this.loading = true
        this.error = null
        this.render()
        return
      }

      if (detail.type === 'did-stop-loading') {
        this.loading = false
        this.error = null
        this.mounted = true
        this.render()
        this.scheduleBoundsSync()
        return
      }

      if (detail.type === 'did-fail-load') {
        if (detail.errorCode === -3) {
          return
        }

        this.loading = false
        this.mounted = false
        const description = detail.errorDescription ? String(detail.errorDescription) : 'Unknown external view load error'
        this.error = `Failed to load view "${this._source}": ${description}`
        this.render()
      }
    })
  }

  private getExternalTabId(): string {
    const normalized = this._tabId.trim()
    if (normalized.length > 0) {
      return normalized
    }

    const fallbackSource = this._source.trim()
    return fallbackSource.length > 0 ? `view-${fallbackSource}` : ''
  }

  private getWrapperBounds(): ElectronTabViewBounds {
    if (!this.wrapperEl) {
      return { x: 0, y: 0, width: 0, height: 0 }
    }

    const rect = this.wrapperEl.getBoundingClientRect()
    const width = Math.max(0, Math.floor(rect.width))
    const height = Math.max(0, Math.floor(rect.height))
    return {
      x: Math.max(0, Math.floor(rect.left)),
      y: Math.max(0, Math.floor(rect.top)),
      width,
      height,
    }
  }

  private isViewVisible(bounds?: ElectronTabViewBounds): boolean {
    const nextBounds = bounds || this.getWrapperBounds()
    return (
      document.visibilityState === 'visible' &&
      this.offsetParent !== null &&
      nextBounds.width > 0 &&
      nextBounds.height > 0
    )
  }

  private destroyTabViewHost() {
    const tools = window.electronClientTools
    const tabId = this.getExternalTabId()
    if (!tools || typeof tools.destroyTabView !== 'function' || !tabId) {
      this.mounted = false
      return
    }

    void tools.destroyTabView({ tabId }).catch(() => {
      // Ignore teardown failures while switching tabs/views.
    })
    this.mounted = false
  }

  private scheduleBoundsSync() {
    if (this.pendingBoundsAnimationFrame !== null) {
      return
    }

    this.pendingBoundsAnimationFrame = requestAnimationFrame(() => {
      this.pendingBoundsAnimationFrame = null
      this.syncTabViewBounds()
    })
  }

  private syncTabViewBounds() {
    if (!this._source) {
      return
    }

    const tools = window.electronClientTools
    const tabId = this.getExternalTabId()
    if (!tools || typeof tools.updateTabViewBounds !== 'function' || !tabId) {
      return
    }

    const bounds = this.getWrapperBounds()
    const visible = this.isViewVisible(bounds)

    void tools.updateTabViewBounds({
      tabId,
      bounds,
      visible,
    }).catch(() => {
      // Ignore bounds updates when main view is reloading or detached.
    })
  }

  private buildSrc(source: string): string {
    this.viewRevision += 1
    const encodedTabId = encodeURIComponent(this.getExternalTabId())

    if (this._tabType === 'url') {
      // URL tabs load the URL directly
      return source
    }

    if (this._tabType === 'file') {
      // File tabs use agentview://view/ with source=file param
      const encodedPath = encodeURIComponent(source)
      const revision = Date.now()
      return `agentview://view/${encodedPath}?source=file&rev=${encodeURIComponent(String(revision))}&t=${this.viewRevision}&tabId=${encodedTabId}`
    }

    // Default: view
    const encodedViewId = encodeURIComponent(source)
    const revision = this._viewUpdatedAt ?? Date.now()
    return `agentview://view/${encodedViewId}?rev=${encodeURIComponent(String(revision))}&t=${this.viewRevision}&tabId=${encodedTabId}`
  }

  private async loadView(source: string) {
    const requestId = ++this.loadRequestId
    this.error = null
    this.loading = true
    this.render()

    const tools = window.electronClientTools
    if (!tools || typeof tools.mountTabView !== 'function') {
      if (requestId === this.loadRequestId) {
        this.loading = false
        this.error = 'window.electronClientTools.mountTabView is unavailable'
        this.render()
      }
      return
    }

    const tabId = this.getExternalTabId()
    if (!tabId) {
      if (requestId === this.loadRequestId) {
        this.loading = false
        this.error = 'Missing tab id for external view host'
        this.render()
      }
      return
    }

    const bounds = this.getWrapperBounds()
    const visible = this.isViewVisible(bounds)
    const request: ElectronMountTabViewRequest = {
      tabId,
      viewId: source,
      src: this.buildSrc(source),
      bounds,
      visible,
      tabType: this._tabType,
    }

    try {
      await tools.mountTabView(request)
      if (requestId !== this.loadRequestId || !this.isConnected) {
        return
      }

      this.loading = false
      this.error = null
      this.mounted = true
      this.render()
      this.scheduleBoundsSync()
    } catch (error) {
      if (requestId !== this.loadRequestId || !this.isConnected) {
        return
      }

      this.loading = false
      this.mounted = false
      const message = error instanceof Error ? error.message : String(error)
      this.error = `Failed to load view "${source}": ${message}`
      this.render()
    }
  }

  private scheduleLoad(source: string) {
    this.pendingLoadSource = source
    if (this.pendingLoadAnimationFrame !== null) {
      return
    }

    const tryLoad = () => {
      this.pendingLoadAnimationFrame = null
      if (!this.isConnected) {
        return
      }

      const pendingSource = this.pendingLoadSource
      if (!pendingSource) {
        return
      }

      if (!this.isViewVisible()) {
        this.pendingLoadAnimationFrame = requestAnimationFrame(tryLoad)
        return
      }

      this.pendingLoadSource = null
      void this.loadView(pendingSource)
    }

    this.pendingLoadAnimationFrame = requestAnimationFrame(tryLoad)
  }

  private handleReload() {
    if (!this._source) return
    this._viewChanged = false
    this.mounted = false
    this.scheduleLoad(this._source)
  }

  private render() {
    if (!this.containerEl || !this.wrapperEl || !this.loadingEl || !this.errorEl) return

    this.loadingEl.style.display = this.loading ? 'flex' : 'none'
    this.errorEl.style.display = this.error ? 'block' : 'none'
    this.errorEl.textContent = this.error || ''
  }
}

function parseOptionalNumber(value: string | null): number | null {
  if (!value || value.trim().length === 0) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
