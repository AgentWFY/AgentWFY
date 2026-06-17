import type { DisplayMessage, ProviderInfo } from '#shared/agent/provider_types.js'
import type { FileContent, QueuedMessage, RetryState } from '#shared/agent/types.js'
import type {
  AgentSnapshot,
  ProviderState,
  SessionLivePatch,
} from '../ipc-types/index.js'
import { dispatch, listen } from '../events.js'

export interface OpenSession {
  sessionId: string
  label: string
}

export interface AgentSessionState {
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingMessage: DisplayMessage | null
  label: string
  streamingSessionsCount: number
  notifyOnFinish: boolean
  statusLine: string
  providerId: string
  activeSessionId: string | null
  streamingSessionIds: string[]
  retryState: RetryState | null
  stalledSince: number | null
  queuedMessages: QueuedMessage[]

  openSessions: OpenSession[]
  providerList: ProviderInfo[]
  defaultProviderId: string
  selectedProviderId: string
  providerStatusLines: Map<string, string>
  configStatusLine: string
  ready: boolean
}

function defaultState(): AgentSessionState {
  return {
    messages: [],
    isStreaming: false,
    streamingMessage: null,
    label: '',
    streamingSessionsCount: 0,
    notifyOnFinish: false,
    statusLine: '',
    providerId: '',
    activeSessionId: null,
    streamingSessionIds: [],
    retryState: null,
    stalledSince: null,
    queuedMessages: [],
    openSessions: [],
    providerList: [],
    defaultProviderId: '',
    selectedProviderId: '',
    providerStatusLines: new Map(),
    configStatusLine: '',
    ready: false,
  }
}

class AgentSessionService {
  private _state: AgentSessionState = defaultState()
  private _snapshotUnsub: (() => void) | null = null
  private _streamingUnsub: (() => void) | null = null
  private _providerStateUnsub: (() => void) | null = null
  private _stateCache = new Map<string, AgentSessionState>()
  private _currentAgentId: string | null = null
  private _unsubs: Array<() => void> = []
  private _generation = 0

  get state(): Readonly<AgentSessionState> {
    return this._state
  }

  getCurrentAgentId(): string | null {
    return this._currentAgentId
  }

  hasAgentApi(): boolean {
    return !!window.ipc?.agent
  }

  install(): void {
    this.destroy()

    const ipc = window.ipc
    if (!ipc?.agent) return

    this._snapshotUnsub = ipc.agent.onSnapshot((snapshot) => {
      this.applySnapshot(snapshot)
    })

    this._streamingUnsub = ipc.agent.onStreaming((patch) => {
      this.applyStreamingPatch(patch)
    })

    this._providerStateUnsub = ipc.providers?.onStateChanged((state) => {
      this.applyProviderState(state)
    }) ?? null

    this._currentAgentId = window.ipc?.agentId ?? null
    this._unsubs.push(listen('agent-switched', this.onAgentSwitched))

    const generation = this._generation
    ipc.agent.getSnapshot().then((snapshot) => {
      if (generation !== this._generation) return
      if (snapshot) this.applySnapshot(snapshot)
    }).catch((err: unknown) => {
      console.warn('[agent-session] initial snapshot failed:', err)
    })
  }

  destroy(): void {
    this._generation += 1
    this._snapshotUnsub?.()
    this._snapshotUnsub = null
    this._streamingUnsub?.()
    this._streamingUnsub = null
    this._providerStateUnsub?.()
    this._providerStateUnsub = null
    for (const off of this._unsubs) off()
    this._unsubs.length = 0
  }

  async sendMessage(text: string, files?: FileContent[]): Promise<void> {
    const ipc = window.ipc?.agent
    if (!ipc) return

    const { messages, isStreaming, selectedProviderId } = this._state
    const isFirstMessage = messages.length === 0 && !isStreaming

    if (isStreaming) {
      await ipc.sendMessage(text, { streamingBehavior: 'followUp', files })
    } else if (isFirstMessage) {
      const providerId = selectedProviderId || undefined
      await ipc.createSession({ prompt: text, providerId, files })
    } else {
      await ipc.sendMessage(text, { files })
    }
  }

  async createSession(): Promise<void> {
    this.setState({ selectedProviderId: this._state.defaultProviderId })
    await window.ipc?.agent.createSession()
  }

  async loadSession(sessionId: string): Promise<void> {
    await window.ipc?.agent.loadSession(sessionId)
  }

  async closeSession(): Promise<void> {
    await window.ipc?.agent.closeSession()
  }

  async abort(): Promise<void> {
    if (!this._state.isStreaming && !this._state.retryState) return
    await window.ipc?.agent.abort()
  }

  async reconnect(): Promise<void> {
    this.setState({ statusLine: '' })
    await window.ipc?.agent.reconnect()
  }

  async retryNow(): Promise<void> {
    await window.ipc?.agent.retryNow()
  }

  async removeQueuedMessage(index: number): Promise<void> {
    await window.ipc?.agent.removeQueuedMessage(index)
  }

  async setNotifyOnFinish(value: boolean): Promise<void> {
    await window.ipc?.agent.setNotifyOnFinish(value)
  }

  async getSessionList(): Promise<unknown[]> {
    return await window.ipc?.agent.getSessionList() ?? []
  }

  addOpenSession(sessionId: string, label: string): void {
    const sessions = this._state.openSessions
    if (sessions.some((s) => s.sessionId === sessionId)) return
    this.setState({ openSessions: [...sessions, { sessionId, label }] })
  }

  removeOpenSession(sessionId: string): void {
    const wasCurrent = sessionId === this._state.activeSessionId
    const filtered = this._state.openSessions.filter((s) => s.sessionId !== sessionId)
    this.setState({ openSessions: filtered })

    void window.ipc?.agent.unloadSession(sessionId)

    if (!wasCurrent) return
    const next = filtered[0]
    if (next) {
      void this.loadSession(next.sessionId)
    } else {
      void this.createSession()
    }
  }

  selectProvider(id: string): void {
    this.setState({ selectedProviderId: id })
  }

  async setDefaultProvider(id: string): Promise<void> {
    await window.ipc?.providers?.setDefault(id)
  }

  private onAgentSwitched = (detail: { agentId: string | null; agents: Array<{ agentId: string }> }) => {
    const newAgentId = detail.agentId
    if (newAgentId === this._currentAgentId) return

    if (this._currentAgentId) {
      this._stateCache.set(this._currentAgentId, { ...this._state })
    }

    const previousState = this._state
    const cached = newAgentId ? this._stateCache.get(newAgentId) : null
    this._state = cached ? { ...cached, ready: false } : { ...defaultState(), ready: false }

    const activeIds = new Set(detail.agents.map((a) => a.agentId))
    for (const key of this._stateCache.keys()) {
      if (!activeIds.has(key)) this._stateCache.delete(key)
    }

    this._currentAgentId = newAgentId
    this._generation += 1
    this.emitChangedState(previousState, this._state)
  }

  private applyProviderState(state: ProviderState): void {
    const providerList = state.providerList ?? []
    const defaultProviderId = state.defaultProviderId ?? 'openai-compatible'
    const providerStatusLines = new Map(state.providerStatusLines ?? [])
    const selectedStillValid = providerList.some((p) => p.id === this._state.selectedProviderId)
    const activeId = this._state.providerId || defaultProviderId
    this.setState({
      providerList,
      providerStatusLines,
      defaultProviderId,
      selectedProviderId: selectedStillValid ? this._state.selectedProviderId : defaultProviderId,
      configStatusLine: providerStatusLines.get(activeId) || '',
    })
  }

  private applySnapshot(snapshot: AgentSnapshot): void {
    const providerChanged = snapshot.providerId && snapshot.providerId !== this._state.providerId
    const patch: Partial<AgentSessionState> = {
      messages: snapshot.messages,
      isStreaming: snapshot.isStreaming,
      streamingMessage: snapshot.streamingMessage,
      label: snapshot.label,
      streamingSessionsCount: snapshot.streamingSessionsCount,
      notifyOnFinish: snapshot.notifyOnFinish,
      statusLine: snapshot.statusLine || '',
      providerId: snapshot.providerId,
      activeSessionId: snapshot.activeSessionId ?? null,
      streamingSessionIds: snapshot.streamingSessionIds ?? [],
      retryState: snapshot.retryState ?? null,
      stalledSince: snapshot.stalledSince ?? null,
      queuedMessages: snapshot.queuedMessages ?? [],
      ready: true,
    }

    if (providerChanged) {
      patch.configStatusLine = this._state.providerStatusLines.get(snapshot.providerId) || ''
    }

    if (snapshot.activeSessionId && (snapshot.messages.length > 0 || snapshot.isStreaming)) {
      const sessions = this._state.openSessions
      const existingIdx = sessions.findIndex((os) => os.sessionId === snapshot.activeSessionId)
      const label = snapshot.label || 'New session'
      if (existingIdx < 0) {
        patch.openSessions = [...sessions, { sessionId: snapshot.activeSessionId, label }]
      } else if (sessions[existingIdx].label !== label) {
        const updated = sessions.slice()
        updated[existingIdx] = { ...updated[existingIdx], label }
        patch.openSessions = updated
      }
    }

    this.setState(patch)
  }

  private applyStreamingPatch(patch: SessionLivePatch): void {
    const partial: Partial<AgentSessionState> = { streamingMessage: patch.streamingMessage }
    if (patch.statusLine !== undefined) partial.statusLine = patch.statusLine
    if (patch.isStreaming !== undefined) partial.isStreaming = patch.isStreaming
    if (patch.retryState !== undefined) partial.retryState = patch.retryState
    if (patch.stalledSince !== undefined) partial.stalledSince = patch.stalledSince
    this.setState(partial)
  }

  private setState(partial: Partial<AgentSessionState>): void {
    const changedKeys: Array<keyof AgentSessionState> = []
    const cur = this._state as unknown as Record<string, unknown>
    const upd = partial as unknown as Record<string, unknown>
    for (const key in upd) {
      if (cur[key] !== upd[key]) changedKeys.push(key as keyof AgentSessionState)
    }
    if (changedKeys.length === 0) return
    this._state = { ...this._state, ...partial }
    this.emitStateChanged(changedKeys)
  }

  private emitStateChanged(changedKeys: Array<keyof AgentSessionState>): void {
    dispatch('agent-state-changed', { state: this._state, changedKeys })
  }

  private emitChangedState(previous: AgentSessionState, next: AgentSessionState): void {
    const changedKeys: Array<keyof AgentSessionState> = []
    const prev = previous as unknown as Record<string, unknown>
    const cur = next as unknown as Record<string, unknown>
    for (const key of Object.keys(cur)) {
      if (prev[key] !== cur[key]) changedKeys.push(key as keyof AgentSessionState)
    }
    if (changedKeys.length > 0) this.emitStateChanged(changedKeys)
  }
}

export const agentSession = new AgentSessionService()
