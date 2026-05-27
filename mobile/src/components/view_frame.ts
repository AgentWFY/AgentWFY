// The agentview:// iframe for the currently open view. Receives view-name
// and view-version attributes from the router-shell. Reuses the same
// iframe element across version bumps so the WebView doesn't tear down
// its session — only swaps src when name or version actually changes.

export class TlViewFrame extends HTMLElement {
  static get observedAttributes() { return ['view-name', 'view-version'] }

  private wrapEl!: HTMLDivElement
  private frameEl: HTMLIFrameElement | null = null
  private mountedName: string | null = null
  private mountedVersion: number | null = null

  connectedCallback() {
    this.innerHTML = `<div class="view-frame-wrap" data-role="wrap"></div>`
    this.wrapEl = this.querySelector<HTMLDivElement>('[data-role="wrap"]')!
    this.sync()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync()
  }

  private sync() {
    const name = this.getAttribute('view-name')
    if (!name) return
    const version = Number(this.getAttribute('view-version') ?? '0')
    if (!this.frameEl) {
      this.frameEl = document.createElement('iframe')
      this.frameEl.className = 'view-frame'
      this.frameEl.setAttribute('title', 'Agent view')
      this.frameEl.setAttribute('referrerpolicy', 'no-referrer')
      this.wrapEl.appendChild(this.frameEl)
    }
    if (this.mountedName !== name || this.mountedVersion !== version) {
      this.frameEl.setAttribute('src', buildViewSrc(name, version))
      this.mountedName = name
      this.mountedVersion = version
    }
  }
}

function buildViewSrc(name: string, version: number): string {
  return `agentview://localhost/view/${encodeURIComponent(name)}?tabId=mobile-view&rev=${version}`
}
