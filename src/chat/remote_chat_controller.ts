// RemoteChatController — desktop chat controller for a remote-backed agent.
//
// The daemon owns sessions; the desktop owns which remote session is shown in
// the chat panel. The controller keeps a local SessionState cache for the
// displayed session: metadata is filled once via `sessions.get`, then folded
// from pushed `session:state` events. `getSnapshot()` reads the cache and
// never hits the network after that initial fetch.

import type {
  AgentBackend,
  AgentBackendEvent,
  BackendStatusSnapshot,
  SessionLivePatch,
  SessionState,
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
  private cachedState: SessionState | null = null
  private readonly liveStates = new Map<string, SessionLivePatch>()
  private cacheLoad: Promise<void> | null = null
  private readonly chatChangeHandlers = new Set<() => void>()
  private eventsUnsubscribe: Unsubscribe | null = null
  private statusUnsubscribe: Unsubscribe | null = null

  constructor(private readonly backend: AgentBackend) {}

  getDisplayedSessionId(): string | null {
    return this.displayedSessionId
  }

  async setDisplayedSessionId(sessionId: string | null): Promise<void> {
    if (this.displayedSessionId === sessionId) {
      if (this.cacheLoad) await this.cacheLoad
      return
    }
    this.displayedSessionId = sessionId
    this.cachedState = null
    if (!sessionId) {
      this.cacheLoad = null
      this.notifyChange()
      return
    }

    await this.startCacheLoad(sessionId)
    if (this.displayedSessionId === sessionId) this.notifyChange()
  }

  private startCacheLoad(sessionId: string): Promise<void> {
    const load = this.loadCachedState(sessionId).finally(() => {
      if (this.cacheLoad === load) this.cacheLoad = null
    })
    this.cacheLoad = load
    return load
  }

  private async loadCachedState(sessionId: string): Promise<void> {
    try {
      const state = await this.backend.sessions.get({ sessionId })
      if (this.displayedSessionId !== sessionId) return
      this.cachedState = state ?? null
      if (state?.live) this.liveStates.set(sessionId, state.live)
    } catch (err) {
      console.warn('[RemoteChatController] initial state fetch failed:', err)
    }
  }

  async getSessionList(): Promise<SessionListItem[]> {
    const summaries = await this.backend.sessions.list()
    return summaries.map((s) => ({
      label: s.title,
      updatedAt: s.updatedAt,
      isActive: this.displayedSessionId === s.sessionId,
      isStreaming: this.liveStates.get(s.sessionId)?.isStreaming ?? false,
      sessionId: s.sessionId,
    }))
  }

  getSnapshot(): AgentSnapshot {
    const backendStatus = statusLineForBackend(this.backend.status.get())
    const current = this.displayedSessionId
    if (!current) return emptySnapshot(backendStatus, this.streamingSessionIds())

    const state = this.cachedState
    if (!state || state.sessionId !== current) return emptySnapshot(backendStatus, this.streamingSessionIds())
    const live = state.live ?? null
    const streamingSessionIds = this.streamingSessionIds()
    return {
      messages: state.messages,
      isStreaming: live?.isStreaming ?? false,
      label: state.title || '',
      streamingSessionsCount: streamingSessionIds.length,
      notifyOnFinish: false,
      streamingMessage: live?.streamingMessage ?? null,
      statusLine: live?.statusLine ?? backendStatus,
      providerId: state.providerId,
      activeSessionId: state.sessionId,
      streamingSessionIds,
      retryState: live?.retryState ?? null,
      stalledSince: live?.stalledSince ?? null,
    }
  }

  async createSession(opts: ChatCreateSessionOpts): Promise<string | null> {
    if (!opts.prompt) {
      await this.setDisplayedSessionId(null)
      return null
    }
    const { sessionId } = await this.backend.sessions.spawn({
      prompt: opts.prompt,
      providerId: opts.providerId,
      providerOptions: opts.providerOptions,
    })
    await this.setDisplayedSessionId(sessionId)
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
    await this.setDisplayedSessionId(sessionId)
  }

  async abort(): Promise<void> {
    const current = this.displayedSessionId
    if (!current) return
    await this.backend.sessions.abort({ sessionId: current })
    this.notifyChange()
  }

  async closeSession(): Promise<void> {
    await this.setDisplayedSessionId(null)
  }

  async loadSession(sessionId: string): Promise<void> {
    await this.switchTo(sessionId)
  }

  async switchTo(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    await this.setDisplayedSessionId(sessionId)
  }

  async unloadSession(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return
    if (this.displayedSessionId === sessionId) {
      await this.setDisplayedSessionId(null)
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
    let prevConnectionState: BackendStatusSnapshot['state'] = this.backend.status.get().state
    this.eventsUnsubscribe = this.backend.events.subscribe((evt: AgentBackendEvent) => {
      if (evt.kind === 'session:removed') {
        this.liveStates.delete(evt.sessionId)
        if (evt.sessionId !== this.displayedSessionId) return
        this.displayedSessionId = null
        this.cachedState = null
        this.cacheLoad = null
        this.notifyChange()
        return
      }
      if (evt.kind !== 'session:state') return
      this.liveStates.set(evt.sessionId, evt.live)
      if (evt.sessionId !== this.displayedSessionId) {
        this.notifyChange()
        return
      }
      // Skip events that arrive before the initial fetch populates the cache:
      // title/providerId come only from sessions.get.
      const current = this.cachedState
      if (!current || current.sessionId !== evt.sessionId) return
      this.cachedState = {
        ...current,
        live: evt.live,
        ...(evt.messages !== undefined ? { messages: evt.messages } : {}),
        ...(evt.title !== undefined ? { title: evt.title } : {}),
      }
      this.notifyChange()
    })
    this.statusUnsubscribe = this.backend.status.subscribe((status) => {
      const prev = prevConnectionState
      prevConnectionState = status.state
      // Re-fetch after reconnect: any events fired while we were offline
      // never reached this client.
      if (prev !== 'connected' && status.state === 'connected' && this.displayedSessionId) {
        const sessionId = this.displayedSessionId
        void this.startCacheLoad(sessionId).then(() => {
          if (this.displayedSessionId === sessionId) this.notifyChange()
        })
      }
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

  private streamingSessionIds(): string[] {
    return [...this.liveStates.entries()]
      .filter(([, item]) => item.isStreaming)
      .map(([sessionId]) => sessionId)
  }
}

function statusLineForBackend(status: BackendStatusSnapshot): string | undefined {
  if (status.state === 'connected') return undefined
  return status.message || 'Remote agent is not connected'
}

function emptySnapshot(statusLine?: string | undefined, streamingSessionIds: string[] = []): AgentSnapshot {
  return {
    messages: [],
    isStreaming: false,
    label: '',
    streamingSessionsCount: streamingSessionIds.length,
    notifyOnFinish: false,
    streamingMessage: null,
    statusLine,
    providerId: '',
    activeSessionId: null,
    streamingSessionIds,
    retryState: null,
    stalledSince: null,
  }
}
