// The "connected" main pane — header + body + (in picker mode) bottom
// tabs. Owns the body slot: swaps between session list, agent chat, draft
// compose, view list, and view frame as state.screen / activeSession /
// draftProviderId / activeViewName change.
//
// The header and the bottom tabs subscribe to controller themselves; this
// component only manages which body component is mounted.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'

type BodyKind = 'session-list' | 'agent-chat' | 'draft-compose' | 'view-list' | 'view-frame'

const BODY_TAG: Record<BodyKind, string> = {
  'session-list': 'awfy-session-list',
  'agent-chat': 'awfy-agent-chat',
  'draft-compose': 'awfy-draft-compose',
  'view-list': 'awfy-view-list',
  'view-frame': 'awfy-view-frame',
}

export class TlConnectedPane extends HTMLElement {
  private bodyEl!: HTMLDivElement
  private bottomTabsEl: HTMLElement | null = null
  private currentBodyKind: BodyKind | null = null
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.innerHTML = `
      <awfy-main-header></awfy-main-header>
      <awfy-banner></awfy-banner>
      <div class="body" data-role="body"></div>
    `
    this.bodyEl = this.querySelector<HTMLDivElement>('[data-role="body"]')!
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    if (!state.activeAgentId || !state.activeMeta) {
      // Fresh state — let app.ts swap us out by bouncing back to add-agent.
      controller.setScreen('add-agent')
      return
    }
    this.swapBody(pickBodyKind(state))
    this.toggleBottomTabs(state)
  }

  private swapBody(kind: BodyKind) {
    if (this.currentBodyKind === kind) return
    this.currentBodyKind = kind
    this.bodyEl.innerHTML = `<${BODY_TAG[kind]}></${BODY_TAG[kind]}>`
  }

  private toggleBottomTabs(state: AppState) {
    const wantTabs = state.activeSession === null && state.draftProviderId === null && state.activeViewName === null
    if (wantTabs && !this.bottomTabsEl) {
      this.bottomTabsEl = document.createElement('awfy-bottom-tabs')
      this.appendChild(this.bottomTabsEl)
    } else if (!wantTabs && this.bottomTabsEl) {
      this.bottomTabsEl.remove()
      this.bottomTabsEl = null
    }
    void state
  }
}

function pickBodyKind(state: AppState): BodyKind {
  if (state.screen === 'views') {
    return state.activeViewName ? 'view-frame' : 'view-list'
  }
  if (state.activeSession) return 'agent-chat'
  if (state.draftProviderId !== null) return 'draft-compose'
  return 'session-list'
}
