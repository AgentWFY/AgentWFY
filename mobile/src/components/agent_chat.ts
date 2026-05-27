// Active session body: message list + composer + live status. Matches the
// role of desktop's awfy-agent-chat for an active conversation.
//
// Mounts when state.activeSession is non-null; unmounts when it clears.
// While mounted, re-renders the message list whenever a new patch arrives
// for the same session. The composer (<awfy-chat-input>) and status line
// (<awfy-live-status>) own their own state — they stay across patches.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import type { DisplayMessage } from '#shared/agent/provider_types.js'
import { renderMessagesHtml } from './chat_message_renderer.js'

export class TlAgentChat extends HTMLElement {
  private messageListEl!: HTMLDivElement
  private mountedSessionId: string | null = null
  private unsubscribe: (() => void) | null = null

  connectedCallback() {
    this.innerHTML = `
      <div class="message-list" data-role="message-list"></div>
      <awfy-chat-input mode="followup"></awfy-chat-input>
      <awfy-live-status></awfy-live-status>
    `
    this.messageListEl = this.querySelector<HTMLDivElement>('[data-role="message-list"]')!
    this.unsubscribe = controller.subscribe((state) => this.update(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private update(state: AppState) {
    const session = state.activeSession
    if (!session) return  // connected_pane is about to swap us out
    if (this.mountedSessionId !== session.sessionId) {
      this.mountedSessionId = session.sessionId
    }
    this.renderMessages(state)
  }

  private renderMessages(state: AppState) {
    const wasNearBottom = this.messageListEl.scrollHeight - this.messageListEl.scrollTop - this.messageListEl.clientHeight < 120
    this.messageListEl.innerHTML = renderMessagesHtml(displayMessages(state))
    if (wasNearBottom || state.activeSession?.live?.isStreaming) {
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight
    }
  }
}

function displayMessages(state: AppState): DisplayMessage[] {
  const session = state.activeSession
  if (!session) return []
  const messages = [...session.messages]
  const streaming = session.live?.streamingMessage
  if (streaming) messages.push(streaming)
  return messages
}
