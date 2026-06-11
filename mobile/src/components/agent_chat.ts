// Active session body: message list + composer + live status. Receives
// `session-id` as an attribute from the router-shell. On mount, asks the
// backend service to load the session; while mounted, re-renders the
// message list whenever a session-state event arrives for THIS session.
// The composer and status line stay across patches because they own their
// own state (textarea contents, etc.).

import { backendSession } from '../services/backend-session.js'
import { listen } from '../events.js'
import type { DisplayMessage } from '#shared/agent/provider_types.js'
import type { SessionLivePatch, SessionState } from '#shared/backend/interface.js'
import { renderMessagesHtml } from './chat_message_renderer.js'

export class TlAgentChat extends HTMLElement {
  static get observedAttributes() { return ['session-id'] }

  private messageListEl!: HTMLDivElement
  private composerEl!: HTMLElement
  private statusEl!: HTMLElement
  private currentSessionId: string | null = null
  private currentProviderId: string | null = null
  private messages: DisplayMessage[] = []
  private live: SessionLivePatch | null = null
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.innerHTML = `
      <div class="message-list" data-role="message-list"></div>
      <awfy-chat-input></awfy-chat-input>
      <awfy-live-status></awfy-live-status>
    `
    this.messageListEl = this.querySelector<HTMLDivElement>('[data-role="message-list"]')!
    this.composerEl = this.querySelector<HTMLElement>('awfy-chat-input')!
    this.statusEl = this.querySelector<HTMLElement>('awfy-live-status')!

    this.unsubs.push(
      listen('session-state', ({ sessionId, providerId, messages, live }) => {
        if (sessionId !== this.currentSessionId) return
        if (providerId !== undefined) this.currentProviderId = providerId
        if (messages !== undefined) this.messages = messages
        if (live !== undefined) this.live = live
        this.statusEl.setAttribute('live', JSON.stringify(this.live ?? {}))
        this.syncStatusProvider()
        this.renderMessages()
      }),
      listen('agent-switched', () => {
        // The router-shell will unmount us, but if a stray patch arrives in
        // the meantime, drop the cached state to avoid flashing stale
        // content.
        this.messages = []
        this.live = null
        this.currentProviderId = null
        this.statusEl.setAttribute('live', '{}')
        this.statusEl.removeAttribute('provider-id')
        this.renderMessages()
      }),
    )

    this.applySessionAttr()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  attributeChangedCallback(name: string) {
    if (name === 'session-id' && this.isConnected) this.applySessionAttr()
  }

  private applySessionAttr() {
    const sid = this.getAttribute('session-id')
    if (sid === this.currentSessionId) return
    this.currentSessionId = sid
    this.currentProviderId = null
    this.messages = []
    this.live = null

    if (sid) {
      this.composerEl.setAttribute('session-id', sid)
      this.composerEl.removeAttribute('provider-id')
    } else {
      this.composerEl.removeAttribute('session-id')
    }

    this.statusEl.setAttribute('live', '{}')
    this.statusEl.removeAttribute('provider-id')
    this.renderMessages()
    if (sid) {
      // backend-session.loadSession() will dispatch session-state which the
      // listener above will pick up — no need to update local state here.
      void backendSession.loadSession(sid)
    }
  }

  private syncStatusProvider() {
    if (this.currentProviderId) this.statusEl.setAttribute('provider-id', this.currentProviderId)
    else this.statusEl.removeAttribute('provider-id')
  }

  private renderMessages() {
    const list = composeMessages(this.messages, this.live)
    const wasNearBottom =
      this.messageListEl.scrollHeight - this.messageListEl.scrollTop - this.messageListEl.clientHeight < 120
    this.messageListEl.innerHTML = renderMessagesHtml(list)
    if (wasNearBottom || this.live?.isStreaming) {
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight
    }
  }
}

function composeMessages(messages: SessionState['messages'], live: SessionLivePatch | null): DisplayMessage[] {
  const out = [...messages]
  if (live?.streamingMessage) out.push(live.streamingMessage)
  return out
}
