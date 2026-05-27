// Mobile-only bottom navigation: Chat / Views. Only mounted when the
// connected pane is in picker mode — once the user drills into a session,
// draft, or view, the bottom tabs are removed to give the body full height.

import { controller } from '../controller.js'
import type { AppState, Screen } from '../app-state.js'
import { ICON_CHAT, ICON_GRID } from './icons.js'

export class TlBottomTabs extends HTMLElement {
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.className = 'bottom-tabs'
    this.innerHTML = `
      <button type="button" class="bottom-tab-btn" data-screen="chat">${ICON_CHAT}<span>Chat</span></button>
      <button type="button" class="bottom-tab-btn" data-screen="views">${ICON_GRID}<span>Views</span></button>
    `
    this.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.screen as Screen | undefined
        if (t === 'chat' || t === 'views') controller.setScreen(t)
      })
    })
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    this.querySelectorAll<HTMLButtonElement>('.bottom-tab-btn').forEach((btn) => {
      const active = btn.dataset.screen === state.screen
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-current', active ? 'page' : 'false')
    })
  }
}
