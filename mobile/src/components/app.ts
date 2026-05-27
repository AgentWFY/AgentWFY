// Root mobile shell. Always renders the two-pane layout (agent sidebar +
// main pane); the main pane swaps between the add-agent screen and the
// connected pane based on AppState.screen. Toggles `.is-fullscreen` on
// itself so the agent rail hides during an active session / draft / view
// (see [[feedback-mobile-rail-visibility]]).

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'

export class TlApp extends HTMLElement {
  private shellEl!: HTMLDivElement
  private mainEl!: HTMLElement
  private currentMainKind: 'add-agent' | 'connected' | null = null
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.shellEl = document.createElement('div')
    this.shellEl.className = 'shell'
    this.shellEl.innerHTML = `<awfy-agent-sidebar></awfy-agent-sidebar><main class="main"></main>`
    this.mainEl = this.shellEl.querySelector<HTMLElement>('main.main')!
    this.appendChild(this.shellEl)

    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const fullscreen = state.screen !== 'add-agent' && hasActiveContent(state)
    this.shellEl.classList.toggle('is-fullscreen', fullscreen)

    const wantKind = state.screen === 'add-agent' ? 'add-agent' : 'connected'
    if (this.currentMainKind === wantKind) return
    this.currentMainKind = wantKind
    this.mainEl.innerHTML = wantKind === 'add-agent'
      ? `<awfy-add-agent-screen></awfy-add-agent-screen>`
      : `<awfy-connected-pane></awfy-connected-pane>`
  }
}

export function hasActiveContent(state: AppState): boolean {
  if (state.screen === 'chat') {
    return state.activeSession !== null || state.draftProviderId !== null
  }
  if (state.screen === 'views') return state.activeViewName !== null
  return false
}
