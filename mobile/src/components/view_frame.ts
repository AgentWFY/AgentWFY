// The agentview:// iframe for the current foreground mobile page. Reuses
// the same iframe element across version bumps so the WebView doesn't tear
// down its session — only swaps src when the page source actually changes.

export class TlViewFrame extends HTMLElement {
  static get observedAttributes() { return ['page-id', 'view-name', 'view-version', 'view-params'] }

  private wrapEl!: HTMLDivElement
  private frameEl: HTMLIFrameElement | null = null
  private mountedSrc: string | null = null

  connectedCallback() {
    this.innerHTML = `<div class="view-frame-wrap" data-role="wrap"></div>`
    this.wrapEl = this.querySelector<HTMLDivElement>('[data-role="wrap"]')!
    this.sync()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.sync()
  }

  private sync() {
    const pageId = this.getAttribute('page-id')
    const name = this.getAttribute('view-name')
    if (!pageId || !name) return
    const version = Number(this.getAttribute('view-version') ?? '0')
    const params = parseParams(this.getAttribute('view-params'))
    if (!this.frameEl) {
      this.frameEl = document.createElement('iframe')
      this.frameEl.className = 'view-frame'
      this.frameEl.setAttribute('title', 'Agent view')
      this.frameEl.setAttribute('referrerpolicy', 'no-referrer')
      this.wrapEl.appendChild(this.frameEl)
    }
    const src = buildViewSrc({ pageId, name, version, params })
    if (this.mountedSrc !== src) {
      this.frameEl.setAttribute('src', src)
      this.mountedSrc = src
    }
  }
}

function buildViewSrc(options: {
  pageId: string
  name: string
  version: number
  params: Record<string, string>
}): string {
  let src = `agentview://localhost/view/${encodeURIComponent(options.name)}?tabId=${encodeURIComponent(options.pageId)}&rev=${encodeURIComponent(String(options.version))}`
  for (const [key, value] of Object.entries(options.params)) {
    src += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  }
  return src
}

function parseParams(value: string | null): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}
