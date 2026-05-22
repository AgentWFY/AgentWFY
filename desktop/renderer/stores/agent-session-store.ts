import type {
  DisplayMessage,
  OpenSession,
  ProviderInfo,
  AgentSnapshot,
  RetryState,
} from './types.js'
import type { ProviderState, SessionLivePatch } from '../../ipc/schema.js'
import type { FileContent } from '#shared/agent/types.js'

export interface AgentSessionState {
  // From IPC snapshots
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

  // Renderer-only
  openSessions: OpenSession[]
  providerList: ProviderInfo[]
  defaultProviderId: string
  selectedProviderId: string
  providerStatusLines: Map<string, string>
  configStatusLine: string
  ready: boolean
}

interface Subscription<T = unknown> {
  selector: (s: AgentSessionState) => T
  listener: (value: T) => void
  prev: T
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
    openSessions: [],
    providerList: [],
    defaultProviderId: '',
    selectedProviderId: '',
    providerStatusLines: new Map(),
    configStatusLine: '',
    ready: false,
  }
}

class AgentSessionStore {
  private _state: AgentSessionState = defaultState()
  private _subscriptions: Subscription[] = []
  private _snapshotUnsub: (() => void) | null = null
  private _streamingUnsub: (() => void) | null = null
  private _providerStateUnsub: (() => void) | null = null
  private _stateCache = new Map<string, AgentSessionState>()
  private _currentAgentId: string | null = null

  get state(): Readonly<AgentSessionState> {
    return this._state
  }

  /**
   * Subscribe to a specific slice of state. The listener is only called
   * when the selector's return value changes (by reference equality).
   */
  select<T>(selector: (s: AgentSessionState) => T, listener: (value: T) => void): () => void {
    const prev = selector(this._state)
    const entry: Subscription<T> = { selector, listener, prev }
    this._subscriptions.push(entry as Subscription)
    return () => {
      const idx = this._subscriptions.indexOf(entry as Subscription)
      if (idx >= 0) this._subscriptions.splice(idx, 1)
    }
  }

  /** Subscribe to any state change. */
  subscribe(listener: () => void): () => void {
    // Selector returns an incrementing counter so it always differs from
    // prev, ensuring the listener fires on every notify().
    let version = 0
    return this.select(() => version++, () => listener())
  }

  /** Connect to IPC channels and load initial state. Safe to call multiple times. */
  init(): void {
    this.destroy()

    const ipc = window.ipc
    if (!ipc?.agent) return

    this._snapshotUnsub = ipc.agent.onSnapshot((snapshot) => {
      this.applySnapshot(snapshot)
    })

    this._streamingUnsub = ipc.agent.onStreaming((d: SessionLivePatch) => {
      const patch: Partial<AgentSessionState> = { streamingMessage: d.streamingMessage }
      if (d.statusLine !== undefined) patch.statusLine = d.statusLine
      if (d.isStreaming !== undefined) patch.isStreaming = d.isStreaming
      if (d.retryState !== undefined) patch.retryState = d.retryState
      if (d.stalledSince !== undefined) patch.stalledSince = d.stalledSince
      this.setState(patch)
    })

    // Initial snapshot
    ipc.agent.getSnapshot().then((snapshot) => {
      if (snapshot) this.applySnapshot(snapshot)
    }).catch((err: unknown) => {
      console.warn('[AgentSessionStore] initial snapshot failed:', err)
    })

    this._providerStateUnsub = ipc.providers?.onStateChanged((state: ProviderState) => {
      this.applyProviderState(state)
    }) ?? null

    this._currentAgentId = window.ipc?.agentId ?? null

    window.addEventListener('agentwfy:agent-switched', this._onAgentSwitched)
  }

  /** Save current state per-agent and restore cached state for the new agent. */
  private _onAgentSwitched = (e: Event) => {
    const detail = (e as CustomEvent).detail
    const newAgentId: string | null = detail?.agentId ?? null
    const agents: Array<{ agentId: string }> | undefined = detail?.agents

    // Skip if the agent hasn't actually changed (e.g. broadcastSidebarState after trigger start)
    if (newAgentId === this._currentAgentId) return

    // Save current state for the previous agent
    if (this._currentAgentId) {
      this._stateCache.set(this._currentAgentId, { ...this._state })
    }

    // Restore cached state or use default
    const cached = newAgentId ? this._stateCache.get(newAgentId) : null
    if (cached) {
      this._state = { ...cached, ready: false }
    } else {
      this._state = { ...defaultState(), ready: false }
    }

    // Clean up cache entries for removed agents
    if (agents) {
      const activeIds = new Set(agents.map(a => a.agentId))
      for (const key of this._stateCache.keys()) {
        if (!activeIds.has(key)) this._stateCache.delete(key)
      }
    }

    this._currentAgentId = newAgentId
    this.notify()
  }

  destroy(): void {
    this._snapshotUnsub?.()
    this._snapshotUnsub = null
    this._streamingUnsub?.()
    this._streamingUnsub = null
    this._providerStateUnsub?.()
    this._providerStateUnsub = null
    this._subscriptions.length = 0
    window.removeEventListener('agentwfy:agent-switched', this._onAgentSwitched)
  }

  // ── Session actions ──

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
    if (!this._state.isStreaming) return
    await window.ipc?.agent.abort()
  }

  async reconnect(): Promise<void> {
    this.setState({ statusLine: '' })
    await window.ipc?.agent.reconnect()
  }

  async retryNow(): Promise<void> {
    await window.ipc?.agent.retryNow()
  }

  async setNotifyOnFinish(value: boolean): Promise<void> {
    await window.ipc?.agent.setNotifyOnFinish(value)
  }

  async getSessionList(): Promise<unknown[]> {
    return await window.ipc?.agent.getSessionList() ?? []
  }

  // ── Open sessions ──

  addOpenSession(sessionId: string, label: string): void {
    const sessions = this._state.openSessions
    if (sessions.some(s => s.sessionId === sessionId)) return
    this.setState({ openSessions: [...sessions, { sessionId, label }] })
  }

  removeOpenSession(sessionId: string): void {
    const wasCurrent = sessionId === this._state.activeSessionId
    const filtered = this._state.openSessions.filter(s => s.sessionId !== sessionId)
    this.setState({ openSessions: filtered })

    void window.ipc?.agent.unloadSession(sessionId)

    if (wasCurrent) {
      const next = filtered[0]
      if (next) {
        this.loadSession(next.sessionId)
      } else {
        this.createSession()
      }
    }
  }

  // ── Providers ──

  private applyProviderState(state: ProviderState): void {
    const providerList = state.providerList ?? []
    const defaultProviderId = state.defaultProviderId ?? 'openai-compatible'
    const providerStatusLines = new Map(state.providerStatusLines ?? [])
    const selectedStillValid = providerList.some(p => p.id === this._state.selectedProviderId)
    const activeId = this._state.providerId || defaultProviderId
    this.setState({
      providerList,
      providerStatusLines,
      defaultProviderId,
      selectedProviderId: selectedStillValid ? this._state.selectedProviderId : defaultProviderId,
      configStatusLine: providerStatusLines.get(activeId) || '',
    })
  }

  selectProvider(id: string): void {
    this.setState({ selectedProviderId: id })
  }

  async setDefaultProvider(id: string): Promise<void> {
    await window.ipc?.providers?.setDefault(id)
  }

  // ── Internal ──

  /** Apply an IPC snapshot to state in a single setState call. */
  private applySnapshot(s: AgentSnapshot): void {
    const providerChanged = s.providerId && s.providerId !== this._state.providerId
    const patch: Partial<AgentSessionState> = {
      messages: s.messages,
      isStreaming: s.isStreaming,
      streamingMessage: s.streamingMessage,
      label: s.label,
      streamingSessionsCount: s.streamingSessionsCount,
      notifyOnFinish: s.notifyOnFinish,
      statusLine: s.statusLine || '',
      providerId: s.providerId,
      activeSessionId: s.activeSessionId ?? null,
      streamingSessionIds: s.streamingSessionIds ?? [],
      retryState: s.retryState ?? null,
      stalledSince: s.stalledSince ?? null,
      ready: true,
    }

    if (providerChanged) {
      patch.configStatusLine = this._state.providerStatusLines.get(s.providerId) || ''
    }

    // Merge open-session add + label update into the same patch to avoid double notify
    if (s.activeSessionId && (s.messages.length > 0 || s.isStreaming)) {
      const sessions = this._state.openSessions
      const existingIdx = sessions.findIndex(os => os.sessionId === s.activeSessionId)
      const label = s.label || 'New session'
      if (existingIdx < 0) {
        patch.openSessions = [...sessions, { sessionId: s.activeSessionId, label }]
      } else if (sessions[existingIdx].label !== label) {
        const updated = sessions.slice()
        updated[existingIdx] = { ...updated[existingIdx], label }
        patch.openSessions = updated
      }
    }

    this.setState(patch)
  }

  private setState(partial: Partial<AgentSessionState>): void {
    // Skip notify when no field actually changed — avoids redundant renders
    // from heartbeat snapshots and no-op updates.
    let changed = false
    const cur = this._state as unknown as Record<string, unknown>
    const upd = partial as unknown as Record<string, unknown>
    for (const key in upd) {
      if (cur[key] !== upd[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this._state = { ...this._state, ...partial }
    this.notify()
  }

  private notify(): void {
    for (const sub of this._subscriptions) {
      const next = sub.selector(this._state)
      if (next !== sub.prev) {
        sub.prev = next
        sub.listener(next)
      }
    }
  }
}

export const agentSessionStore = new AgentSessionStore()
