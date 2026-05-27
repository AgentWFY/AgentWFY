// Mobile-only bottom navigation: Chat / Views. Parent (<awfy-app>) sets
// the screen attribute; clicking a tab dispatches set-screen back up.

import { dispatch, type Screen } from '../events.js'
import { ICON_CHAT, ICON_GRID } from './icons.js'

export class TlBottomTabs extends HTMLElement {
  static get observedAttributes() { return ['screen'] }

  connectedCallback() {
    this.className = 'bottom-tabs'
    this.innerHTML = `
      <button type="button" class="bottom-tab-btn" data-screen="chat">${ICON_CHAT}<span>Chat</span></button>
      <button type="button" class="bottom-tab-btn" data-screen="views">${ICON_GRID}<span>Views</span></button>
    `
    this.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.screen as Screen | undefined
        if (t === 'chat' || t === 'views') dispatch('set-screen', { screen: t })
      })
    })
    this.applyActive()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.applyActive()
  }

  private applyActive() {
    const current = this.getAttribute('screen') ?? 'chat'
    this.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
      const active = btn.dataset.screen === current
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-current', active ? 'page' : 'false')
    })
  }
}
