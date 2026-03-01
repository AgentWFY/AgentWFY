import type {
  ElectronExternalViewBounds,
  ElectronExternalViewEvent,
  ElectronMountExternalViewRequest,
} from '../electron_agent_tools'

export class TlExternalView extends HTMLElement {
  private _tabId = ''
  private _viewId = ''
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
  private pendingLoadViewId: string | null = null
  private pendingLoadAnimationFrame: number | null = null
  private pendingBoundsAnimationFrame: number | null = null
  private wrapperResizeObserver: ResizeObserver | null = null
  private parentVisibilityObserver: MutationObserver | null = null
  private unsubscribeExternalViewEvents: (() => void) | null = null
  private onRefreshView = (e: Event) => {
    const detail = (e as CustomEvent).detail
    if (detail.viewId === this._tabId) {
      this.handleReload()
    }
  }

  private onWindowOrVisibilityChanged = () => {
    this.scheduleBoundsSync()

    if (!this.mounted && this._viewId) {
      this.scheduleLoadExternalView(this._viewId)
    }
  }

  static get observedAttributes() {
    return ['tab-id', 'view-id', 'view-path', 'view-updated-at']
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null) {
    const nextValue = value || ''
    if (name === 'tab-id') this._tabId = nextValue
    if (name === 'view-id') this._viewId = nextValue
    if (name === 'view-path' && !this.hasAttribute('view-id')) this._viewId = nextValue
    if (name === 'view-updated-at') this._viewUpdatedAt = parseOptionalNumber(value)

    if (!this.isConnected || oldValue === nextValue) return

    if (name === 'view-id' || name === 'view-path' || name === 'view-updated-at') {
      this._viewChanged = false
      this.mounted = false

      if (this._viewId) {
        this.scheduleLoadExternalView(this._viewId)
        this.scheduleBoundsSync()
      } else {
        this.loadRequestId += 1
        this.loading = false
        this.error = null
        this.pendingLoadViewId = null
        if (this.pendingLoadAnimationFrame !== null) {
          cancelAnimationFrame(this.pendingLoadAnimationFrame)
          this.pendingLoadAnimationFrame = null
        }
        this.destroyExternalViewHost()
        this.render()
      }
    }
  }

  get tabId() { return this._tabId }
  get viewId() { return this._viewId }

  get viewChanged() { return this._viewChanged }
  set viewChanged(value: boolean) {
    this._viewChanged = value
    this.render()
  }

  connectedCallback() {
    this._tabId = this.getAttribute('tab-id') || ''
    this._viewId = this.getAttribute('view-id') || this.getAttribute('view-path') || ''
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
    this.subscribeToExternalViewEvents()

    window.addEventListener('agentwfy:refresh-view', this.onRefreshView)
    window.addEventListener('resize', this.onWindowOrVisibilityChanged)
    document.addEventListener('visibilitychange', this.onWindowOrVisibilityChanged)

    this.render()

    if (this._viewId) {
      this.scheduleLoadExternalView(this._viewId)
      this.scheduleBoundsSync()
    }
  }

  disconnectedCallback() {
    this.loadRequestId += 1
    this.loading = false
    this.pendingLoadViewId = null

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

    if (this.unsubscribeExternalViewEvents) {
      this.unsubscribeExternalViewEvents()
      this.unsubscribeExternalViewEvents = null
    }

    window.removeEventListener('agentwfy:refresh-view', this.onRefreshView)
    window.removeEventListener('resize', this.onWindowOrVisibilityChanged)
    document.removeEventListener('visibilitychange', this.onWindowOrVisibilityChanged)

    this.destroyExternalViewHost()
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

      if (!this.mounted && this._viewId) {
        this.scheduleLoadExternalView(this._viewId)
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

      if (!this.mounted && this._viewId) {
        this.scheduleLoadExternalView(this._viewId)
      }
    })

    this.parentVisibilityObserver.observe(parent, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
  }

  private subscribeToExternalViewEvents() {
    const tools = window.electronClientTools
    if (!tools || typeof tools.onExternalViewEvent !== 'function') {
      return
    }

    if (this.unsubscribeExternalViewEvents) {
      this.unsubscribeExternalViewEvents()
      this.unsubscribeExternalViewEvents = null
    }

    this.unsubscribeExternalViewEvents = tools.onExternalViewEvent((detail: ElectronExternalViewEvent) => {
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
        this.error = `Failed to load view "${this._viewId}": ${description}`
        this.render()
      }
    })
  }

  private getExternalTabId(): string {
    const normalized = this._tabId.trim()
    if (normalized.length > 0) {
      return normalized
    }

    const fallbackViewId = this._viewId.trim()
    return fallbackViewId.length > 0 ? `view-${fallbackViewId}` : ''
  }

  private getWrapperBounds(): ElectronExternalViewBounds {
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

  private isViewVisible(bounds?: ElectronExternalViewBounds): boolean {
    const nextBounds = bounds || this.getWrapperBounds()
    return (
      document.visibilityState === 'visible' &&
      this.offsetParent !== null &&
      nextBounds.width > 0 &&
      nextBounds.height > 0
    )
  }

  private destroyExternalViewHost() {
    const tools = window.electronClientTools
    const tabId = this.getExternalTabId()
    if (!tools || typeof tools.destroyExternalView !== 'function' || !tabId) {
      this.mounted = false
      return
    }

    void tools.destroyExternalView({ tabId }).catch(() => {
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
      this.syncExternalViewBounds()
    })
  }

  private syncExternalViewBounds() {
    if (!this._viewId) {
      return
    }

    const tools = window.electronClientTools
    const tabId = this.getExternalTabId()
    if (!tools || typeof tools.updateExternalViewBounds !== 'function' || !tabId) {
      return
    }

    const bounds = this.getWrapperBounds()
    const visible = this.isViewVisible(bounds)

    void tools.updateExternalViewBounds({
      tabId,
      bounds,
      visible,
    }).catch(() => {
      // Ignore bounds updates when main view is reloading or detached.
    })
  }

  private buildExternalViewSrc(viewId: string): string {
    this.viewRevision += 1
    const revision = this._viewUpdatedAt ?? Date.now()
    const encodedViewId = encodeURIComponent(viewId)
    const encodedTabId = encodeURIComponent(this.getExternalTabId())
    return `agentview://view/${encodedViewId}?rev=${encodeURIComponent(String(revision))}&t=${this.viewRevision}&tabId=${encodedTabId}`
  }

  private async loadExternalView(viewId: string) {
    const requestId = ++this.loadRequestId
    this.error = null
    this.loading = true
    this.render()

    const tools = window.electronClientTools
    if (!tools || typeof tools.mountExternalView !== 'function') {
      if (requestId === this.loadRequestId) {
        this.loading = false
        this.error = 'window.electronClientTools.mountExternalView is unavailable'
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
    const request: ElectronMountExternalViewRequest = {
      tabId,
      viewId,
      src: this.buildExternalViewSrc(viewId),
      bounds,
      visible,
    }

    try {
      await tools.mountExternalView(request)
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
      this.error = `Failed to load view "${viewId}": ${message}`
      this.render()
    }
  }

  private scheduleLoadExternalView(viewId: string) {
    this.pendingLoadViewId = viewId
    if (this.pendingLoadAnimationFrame !== null) {
      return
    }

    const tryLoad = () => {
      this.pendingLoadAnimationFrame = null
      if (!this.isConnected) {
        return
      }

      const pendingViewId = this.pendingLoadViewId
      if (!pendingViewId) {
        return
      }

      if (!this.isViewVisible()) {
        this.pendingLoadAnimationFrame = requestAnimationFrame(tryLoad)
        return
      }

      this.pendingLoadViewId = null
      void this.loadExternalView(pendingViewId)
    }

    this.pendingLoadAnimationFrame = requestAnimationFrame(tryLoad)
  }

  private handleReload() {
    if (!this._viewId) return
    this._viewChanged = false
    this.mounted = false
    this.scheduleLoadExternalView(this._viewId)
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
