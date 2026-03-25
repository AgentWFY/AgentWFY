import type {
  DisplayMessage,
  OpenSession,
  ProviderInfo,
  AgentSnapshot,
} from './types.js'

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
  activeSessionFile: string | null
  streamingFiles: string[]

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
    activeSessionFile: null,
    streamingFiles: [],
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

    this._snapshotUnsub = ipc.agent.onSnapshot((raw: unknown) => {
      this.applySnapshot(raw as AgentSnapshot)
    })

    this._streamingUnsub = ipc.agent.onStreaming((raw: unknown) => {
      const d = raw as { message: DisplayMessage | null; statusLine?: string; isStreaming?: boolean }
      const patch: Partial<AgentSessionState> = { streamingMessage: d.message }
      if (d.statusLine) patch.statusLine = d.statusLine
      if (d.isStreaming !== undefined) patch.isStreaming = d.isStreaming
      this.setState(patch)
    })

    // Initial snapshot
    ipc.agent.getSnapshot().then((raw: unknown) => {
      if (raw) this.applySnapshot(raw as AgentSnapshot)
    }).catch(() => {})

    this.loadProviders()
  }

  destroy(): void {
    this._snapshotUnsub?.()
    this._snapshotUnsub = null
    this._streamingUnsub?.()
    this._streamingUnsub = null
    this._subscriptions.length = 0
  }

  // ── Session actions ──

  async sendMessage(text: string): Promise<void> {
    const ipc = window.ipc?.agent
    if (!ipc) return

    const { messages, isStreaming, selectedProviderId } = this._state
    const isFirstMessage = messages.length === 0 && !isStreaming

    if (isStreaming) {
      await ipc.sendMessage(text, { streamingBehavior: 'followUp' })
    } else if (isFirstMessage && selectedProviderId) {
      await ipc.createSession({ providerId: selectedProviderId, prompt: text })
    } else if (isFirstMessage) {
      await ipc.createSession({ prompt: text })
    } else {
      await ipc.sendMessage(text)
    }
  }

  async createSession(): Promise<void> {
    this.setState({ selectedProviderId: this._state.defaultProviderId })
    await window.ipc?.agent.createSession()
    await this.loadProviders()
  }

  async loadSession(file: string): Promise<void> {
    await window.ipc?.agent.loadSession(file)
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

  async setNotifyOnFinish(value: boolean): Promise<void> {
    await window.ipc?.agent.setNotifyOnFinish(value)
  }

  async getSessionList(): Promise<unknown[]> {
    return await window.ipc?.agent.getSessionList() ?? []
  }

  // ── Open sessions ──

  addOpenSession(file: string, label: string): void {
    const sessions = this._state.openSessions
    if (sessions.some(s => s.file === file)) return
    this.setState({ openSessions: [...sessions, { file, label }] })
  }

  removeOpenSession(file: string): void {
    const wasCurrent = file === this._state.activeSessionFile
    const filtered = this._state.openSessions.filter(s => s.file !== file)
    this.setState({ openSessions: filtered })

    void window.ipc?.agent.disposeSession(file)

    if (wasCurrent) {
      const next = filtered[0]
      if (next) {
        this.loadSession(next.file)
      } else {
        this.createSession()
      }
    }
  }

  // ── Providers ──

  async loadProviders(): Promise<void> {
    const ipc = window.ipc
    if (!ipc?.providers) return

    let defaultId = 'openai-compatible'
    try {
      const rows = await ipc.sql.run({
        target: 'agent',
        sql: "SELECT value FROM config WHERE name = 'system.provider'",
      }) as Array<{ value: string }>
      if (rows[0]?.value) defaultId = JSON.parse(rows[0].value)
    } catch { /* use fallback */ }

    let providerList: ProviderInfo[] = []
    let providerStatusLines = new Map<string, string>()
    try {
      providerList = await ipc.providers.list()
      const statusEntries = await Promise.all(
        providerList.map(async (p) => {
          try {
            return [p.id, await ipc.providers.getStatusLine(p.id)] as const
          } catch {
            return [p.id, ''] as const
          }
        })
      )
      providerStatusLines = new Map(statusEntries)
    } catch { /* empty list */ }

    const activeId = this._state.providerId || defaultId
    this.setState({
      providerList,
      providerStatusLines,
      defaultProviderId: defaultId,
      selectedProviderId: this._state.selectedProviderId || defaultId,
      configStatusLine: providerStatusLines.get(activeId) || '',
    })
  }

  selectProvider(id: string): void {
    this.setState({ selectedProviderId: id })
  }

  async setDefaultProvider(id: string): Promise<void> {
    const ipc = window.ipc
    if (!ipc) return

    await ipc.sql.run({
      target: 'agent',
      sql: 'UPDATE config SET value = ? WHERE name = ?',
      params: [JSON.stringify(id), 'system.provider'],
      description: 'Set default provider',
    })
    this.setState({ defaultProviderId: id })
  }

  async switchProvider(id: string): Promise<void> {
    const ipc = window.ipc
    if (!ipc) return

    await ipc.sql.run({
      target: 'agent',
      sql: 'UPDATE config SET value = ? WHERE name = ?',
      params: [JSON.stringify(id), 'system.provider'],
      description: 'Set active provider',
    })
    this.setState({
      providerId: id,
      defaultProviderId: id,
    })
    await this.reconnect()
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
      activeSessionFile: s.activeSessionFile ?? null,
      streamingFiles: s.streamingFiles ?? [],
      ready: true,
    }

    if (providerChanged) {
      patch.configStatusLine = this._state.providerStatusLines.get(s.providerId) || ''
    }

    // Merge open-session add + label update into the same patch to avoid double notify
    if (s.activeSessionFile && (s.messages.length > 0 || s.isStreaming)) {
      const sessions = this._state.openSessions
      const existingIdx = sessions.findIndex(os => os.file === s.activeSessionFile)
      const label = s.label || 'New session'
      if (existingIdx < 0) {
        patch.openSessions = [...sessions, { file: s.activeSessionFile, label }]
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
