// The agentview:// iframe for the currently open view. Reuses the same
// iframe element across viewVersion bumps when possible so the WebView
// doesn't tear down its session on every state patch — only swaps src when
// the view name or version actually changes.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'

export class TlViewFrame extends HTMLElement {
  private wrapEl!: HTMLDivElement
  private frameEl: HTMLIFrameElement | null = null
  private mountedName: string | null = null
  private mountedVersion: number | null = null
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.innerHTML = `<div class="view-frame-wrap" data-role="wrap"></div>`
    this.wrapEl = this.querySelector<HTMLDivElement>('[data-role="wrap"]')!
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const name = state.activeViewName
    if (!name) return  // connected_pane is about to swap us out

    if (!this.frameEl) {
      this.frameEl = document.createElement('iframe')
      this.frameEl.className = 'view-frame'
      this.frameEl.setAttribute('title', 'Agent view')
      this.frameEl.setAttribute('referrerpolicy', 'no-referrer')
      this.wrapEl.appendChild(this.frameEl)
    }
    if (this.mountedName !== name || this.mountedVersion !== state.viewVersion) {
      this.frameEl.setAttribute('src', buildViewSrc(name, state.viewVersion))
      this.mountedName = name
      this.mountedVersion = state.viewVersion
    }
  }
}

function buildViewSrc(name: string, version: number): string {
  return `agentview://localhost/view/${encodeURIComponent(name)}?tabId=mobile-view&rev=${version}`
}
