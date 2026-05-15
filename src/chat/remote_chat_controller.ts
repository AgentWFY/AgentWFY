// RemoteChatController — desktop chat controller for a remote-backed agent.
//
// The daemon owns sessions; the desktop owns which remote session is shown in
// the chat panel. Chat changes are surfaced by subscribing to the backend's
// session/status events and to the local `displayedSessionId` slot.

import type {
  AgentBackend,
  AgentBackendEvent,
  BackendStatusSnapshot,
  Unsubscribe,
} from '#shared/backend/interface.js'
import type {
  AgentChatController,
  ChatCreateSessionOpts,
  ChatSendOpts,
  ChatUnsubscribe,
  SessionListItem,
} from '#shared/agent/chat_controller.js'
import type { AgentSnapshot } from '#shared/agent/types.js'

export class RemoteChatController implements AgentChatController {
  private displayedSessionId: string | null = null
  private readonly chatChangeHandlers = new Set<() => void>()
  private eventsUnsubscribe: Unsubscribe | null = null
  private statusUnsubscribe: Unsubscribe | null = null

  constructor(private readonly backend: AgentBackend) {}

  getDisplayedSessionId(): string | null {
    return this.displayedSessionId
  }

  async setDisplayedSessionId(sessionId: string | null): Promise<void> {
    if (this.displayedSessionId === sessionId) return
    this.displayedSessionId = sessionId
    this.notifyChange()
  }

  async getSessionList(): Promise<SessionListItem[]> {
    const summaries = await this.backend.sessions.list()
    return summaries.map((s) => ({
      label: s.title,
      updatedAt: s.updatedAt,
      isActive: this.displayedSessionId === s.sessionId,
      isStreaming: false,
      file: s.sessionId,
      sessionId: s.sessionId,
    }))
  }

  async getSnapshot(): Promise<AgentSnapshot> {
    const backendStatus = statusLineForBackend(this.backend.status.get())
    const current = this.displayedSessionId
    if (!current) return emptySnapshot(backendStatus)
    const state = await this.backend.sessions.get({ sessionId: current })
    if (!state) return emptySnapshot(backendStatus)
    const live = state.state ?? null
    return {
      messages: live?.messages ?? state.messages,
      isStreaming: live?.isStreaming ?? false,
      label: state.title || '',
      streamingSessionsCount: live?.isStreaming ? 1 : 0,
      notifyOnFinish: false,
      streamingMessage: live?.streamingMessage ?? null,
      statusLine: live?.statusLine ?? backendStatus,
      providerId: state.providerId,
      activeSessionFile: state.sessionId,
      activeSessionId: state.sessionId,
      streamingFiles: live?.isStreaming ? [state.sessionId] : [],
      retryState: live?.retryState ?? null,
      stalledSince: live?.stalledSince ?? null,
    }
  }

  async createSession(opts: ChatCreateSessionOpts): Promise<string | null> {
    if (!opts.prompt) {
      this.displayedSessionId = null
      this.notifyChange()
      return null
    }
    const { sessionId } = await this.backend.sessions.spawn({
      prompt: opts.prompt,
      providerId: opts.providerId,
    })
    this.displayedSessionId = sessionId
    this.notifyChange()
    return sessionId
  }

  async sendMessage(text: string, _opts?: ChatSendOpts): Promise<void> {
    const current = this.displayedSessionId
    if (current) {
      await this.backend.sessions.send({ sessionId: current, text })
      this.notifyChange()
      return
    }
    const { sessionId } = await this.backend.sessions.spawn({ prompt: text })
    this.displayedSessionId = sessionId
    this.notifyChange()
  }

  async abort(): Promise<void> {
    const current = this.displayedSessionId
    if (!current) return
    await this.backend.sessions.abort({ sessionId: current })
    this.notifyChange()
  }

  async closeSession(): Promise<void> {
    this.displayedSessionId = null
    this.notifyChange()
  }

  async loadSession(file: string): Promise<void> {
    this.switchTo(file)
  }

  async switchTo(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (this.displayedSessionId === sessionId) return
    this.displayedSessionId = sessionId
    this.notifyChange()
  }

  async disposeSessionByFile(file: string): Promise<void> {
    if (typeof file !== 'string' || file.trim().length === 0) return
    await this.backend.sessions.remove({ sessionId: file })
    if (this.displayedSessionId === file) {
      this.displayedSessionId = null
      this.notifyChange()
    }
  }

  async setNotifyOnFinish(): Promise<void> {}
  async skipRetryDelay(): Promise<void> {}

  subscribe(handler: () => void): ChatUnsubscribe {
    this.chatChangeHandlers.add(handler)
    this.ensureBackendSubscriptions()
    return () => {
      this.chatChangeHandlers.delete(handler)
      if (this.chatChangeHandlers.size === 0) {
        this.disposeBackendSubscriptions()
      }
    }
  }

  private ensureBackendSubscriptions(): void {
    if (this.eventsUnsubscribe) return
    this.eventsUnsubscribe = this.backend.events.subscribe((evt: AgentBackendEvent) => {
      if (evt.kind !== 'session' && evt.kind !== 'session:state') return
      if (this.displayedSessionId === null) return
      if (evt.sessionId !== this.displayedSessionId) return
      this.notifyChange()
    })
    this.statusUnsubscribe = this.backend.status.subscribe(() => {
      this.notifyChange()
    })
  }

  private disposeBackendSubscriptions(): void {
    this.eventsUnsubscribe?.()
    this.eventsUnsubscribe = null
    this.statusUnsubscribe?.()
    this.statusUnsubscribe = null
  }

  private notifyChange(): void {
    for (const handler of this.chatChangeHandlers) {
      try {
        handler()
      } catch (err) {
        console.error('[RemoteChatController] subscriber threw:', err)
      }
    }
  }
}

function statusLineForBackend(status: BackendStatusSnapshot): string | undefined {
  if (status.state === 'connected') return undefined
  return status.message || 'Remote agent is not connected'
}

function emptySnapshot(statusLine?: string | undefined): AgentSnapshot {
  return {
    messages: [],
    isStreaming: false,
    label: '',
    streamingSessionsCount: 0,
    notifyOnFinish: false,
    streamingMessage: null,
    statusLine,
    providerId: '',
    activeSessionFile: null,
    activeSessionId: null,
    streamingFiles: [],
    retryState: null,
    stalledSince: null,
  }
}
