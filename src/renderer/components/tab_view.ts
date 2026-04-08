import type {
  TabViewBounds,
  TabViewEvent,
} from '../ipc-types/index.js'

export class TlTabView extends HTMLElement {
  private _tabId = ''
  private _source = ''  // viewName for view, filePath for file, url for url
  private _viewChanged = false
  private _hiddenTab = false
  private loading = false
  private error: string | null = null
  private wrapperEl: HTMLDivElement | null = null
  private loadingEl: HTMLDivElement | null = null
  private errorEl: HTMLDivElement | null = null
  private containerEl: HTMLDivElement | null = null
  private pendingBoundsAnimationFrame: number | null = null
  private wrapperResizeObserver: ResizeObserver | null = null
  private parentVisibilityObserver: MutationObserver | null = null
  private unsubscribeTabViewEvents: (() => void) | null = null

  private onWindowOrVisibilityChanged = () => {
    if (!this._hiddenTab) {
      this.scheduleBoundsSync()
    }
  }

  static get observedAttributes() {
    return ['tab-id', 'tab-type', 'view-name', 'view-path', 'view-url', 'view-updated-at', 'hidden-tab', 'view-params']
  }

  attributeChangedCallback(name: string, oldValue: string | null, value: string | null) {
    const nextValue = value || ''
    if (name === 'tab-id') this._tabId = nextValue
    if (name === 'view-name') this._source = nextValue
    if (name === 'view-path' && !this.hasAttribute('view-name')) this._source = nextValue
    if (name === 'view-url' && !this.hasAttribute('view-name') && !this.hasAttribute('view-path')) this._source = nextValue
    if (name === 'hidden-tab') this._hiddenTab = value !== null

    if (!this.isConnected || oldValue === nextValue) return

    if (name === 'view-name' || name === 'view-path' || name === 'view-url' || name === 'view-updated-at') {
      this.scheduleBoundsSync()
    }
  }

  get tabId() { return this._tabId }
  get viewName() { return this._source }

  get viewChanged() { return this._viewChanged }
  set viewChanged(value: boolean) {
    this._viewChanged = value
    this.render()
  }

  connectedCallback() {
    this._tabId = this.getAttribute('tab-id') || ''
    this._source = this.getAttribute('view-name') || this.getAttribute('view-path') || this.getAttribute('view-url') || ''
    this._hiddenTab = this.hasAttribute('hidden-tab')

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

    window.addEventListener('resize', this.onWindowOrVisibilityChanged)
    document.addEventListener('visibilitychange', this.onWindowOrVisibilityChanged)

    this.render()

    if (this._source) {
      this.scheduleBoundsSync()
    }
  }

  disconnectedCallback() {
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

    window.removeEventListener('resize', this.onWindowOrVisibilityChanged)
    document.removeEventListener('visibilitychange', this.onWindowOrVisibilityChanged)
  }

  private initializeUi() {
    this.containerEl = document.createElement('div')
    this.containerEl.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;'

    this.wrapperEl = document.createElement('div')
    this.wrapperEl.style.cssText = 'flex:1;width:100%;min-height:0;overflow:hidden;position:relative;'

    this.loadingEl = document.createElement('div')
    this.loadingEl.style.cssText = 'display:none;align-items:center;justify-content:center;padding:12px;'
    const spinner = document.createElement('div')
    spinner.style.cssText = 'width:32px;height:32px;border:3px solid var(--color-border, #ccc);border-top-color:var(--color-accent, #0078d4);border-radius:50%;animation:awfy-spin 0.8s linear infinite;'
    if (!document.getElementById('awfy-spin-keyframes')) {
      const style = document.createElement('style')
      style.id = 'awfy-spin-keyframes'
      style.textContent = '@keyframes awfy-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(style)
    }
    this.loadingEl.appendChild(spinner)

    this.errorEl = document.createElement('div')
    this.errorEl.style.cssText = 'display:none;padding:16px;border:2px solid red;color:red;font-family:monospace;'

    this.containerEl.appendChild(this.wrapperEl)
    this.containerEl.appendChild(this.loadingEl)
    this.containerEl.appendChild(this.errorEl)

    this.wrapperResizeObserver = new ResizeObserver(() => {
      if (!this._hiddenTab) {
        this.scheduleBoundsSync()
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
      if (!this._hiddenTab) {
        this.scheduleBoundsSync()
      }
    })

    this.parentVisibilityObserver.observe(parent, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
  }

  private subscribeToTabViewEvents() {
    const ipc = window.ipc
    if (!ipc) {
      return
    }

    if (this.unsubscribeTabViewEvents) {
      this.unsubscribeTabViewEvents()
      this.unsubscribeTabViewEvents = null
    }

    this.unsubscribeTabViewEvents = ipc.tabs.onViewEvent((detail: TabViewEvent) => {
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
        this.render()
        this.scheduleBoundsSync()
        return
      }

      if (detail.type === 'did-fail-load') {
        if (detail.errorCode === -3) {
          return
        }

        this.loading = false
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

  private getWrapperBounds(): TabViewBounds {
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

  private isViewVisible(bounds?: TabViewBounds): boolean {
    if (this._hiddenTab) return false

    const nextBounds = bounds || this.getWrapperBounds()
    const MIN_VISIBLE_SIZE = 40
    return (
      document.visibilityState === 'visible' &&
      this.offsetParent !== null &&
      nextBounds.width >= MIN_VISIBLE_SIZE &&
      nextBounds.height >= MIN_VISIBLE_SIZE
    )
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

    const ipc = window.ipc
    const tabId = this.getExternalTabId()
    if (!ipc || !tabId) {
      return
    }

    const bounds = this.getWrapperBounds()
    const visible = this.isViewVisible(bounds)

    void ipc.tabs.updateViewBounds({
      tabId,
      bounds,
      visible,
    }).catch(() => {
      // Ignore bounds updates when main view is reloading or detached.
    })
  }

  private render() {
    if (!this.containerEl || !this.wrapperEl || !this.loadingEl || !this.errorEl) return

    this.loadingEl.style.display = this.loading ? 'flex' : 'none'
    this.errorEl.style.display = this.error ? 'block' : 'none'
    this.errorEl.textContent = this.error || ''
  }
}
