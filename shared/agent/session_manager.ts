import { AgentWFYAgent, DEFAULT_SESSION_DIR } from './create_agent.js'
import type { DisplayMessage } from './provider_types.js'
import type { FileContent } from './types.js'
import type { AgentSnapshot, AgentState } from './types.js'
import { EXECJS_TOOL_DEFINITION } from './provider_types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import { SystemConfigKeys } from '../system-config/keys.js'
import {
  readSessionFile,
  readSessionTitle,
  readSessionMeta,
  listSessionFiles,
  parseStoredSession,
  deleteSessionFile,
  displayMessagesToSearchText,
  stripBlockBinaries,
  type StoredSession,
} from './session_persistence.js'
import type { AgentWFYAgentEvent } from './create_agent.js'
import { escapeRegex } from '../runtime/functions/text_utils.js'
import type { NotificationHost } from '../runtime/hosts.js'

function makeSnippet(text: string, matchIndex: number, matchLength: number, contextChars = 80): string {
  const start = Math.max(0, matchIndex - contextChars)
  const end = Math.min(text.length, matchIndex + matchLength + contextChars)
  let out = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) out = '…' + out
  if (end < text.length) out = out + '…'
  return out
}

function getTextFromDisplayMessage(msg: DisplayMessage): string {
  return msg.blocks
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('\n')
}

function getLastAssistantMessage(messages: DisplayMessage[]): DisplayMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i]
  }
  return undefined
}

function extractFirstUserMessage(messages: DisplayMessage[], maxLen: number): string | null {
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const text = getTextFromDisplayMessage(msg).trim()
    if (text) return text.slice(0, maxLen)
  }
  return null
}

export function sanitizeStreamingMessage(message: DisplayMessage | null): DisplayMessage | null {
  if (!message) return null
  return stripBlockBinaries([message])[0] ?? null
}

function sanitizeAgentState(state: AgentState): AgentState {
  return {
    systemPrompt: '',
    tools: [],
    messages: stripBlockBinaries(state.messages),
    isStreaming: state.isStreaming,
    streamingMessage: sanitizeStreamingMessage(state.streamingMessage),
    statusLine: state.statusLine,
    retryState: state.retryState ?? null,
    stalledSince: state.stalledSince ?? null,
    ...(state.error ? { error: state.error } : {}),
  }
}

interface SessionEntry {
  agent: AgentWFYAgent
  label: string
  unsubscribe: () => void
  /** Forwards typed AgentWFYAgentEvent into agentEventListeners. */
  agentEventUnsubscribe: () => void
  wasStreaming?: boolean
  notifyOnFinish?: boolean
  autoPublishResponse?: boolean
}

export type AgentEventListener = (sessionId: string, event: AgentWFYAgentEvent) => void
export interface SessionLifecycleEvent {
  sessionId: string
  publicSessionId: string
}
export interface SessionLifecycleHandlers {
  onDisposed?: (event: SessionLifecycleEvent) => void
  onRemoved?: (event: SessionLifecycleEvent) => void
}

interface SessionHistoryItem {
  file: string
  updatedAt: number
  firstUserMessage: string
}

export interface SessionListItem {
  label: string
  updatedAt: number
  isActive: boolean
  isStreaming: boolean
  file: string | null
  sessionId: string | null
}

export interface SessionSummary {
  sessionId: string
  title: string
  providerId: string
  updatedAt: number
}

export interface SessionMatch {
  sessionId: string
  title: string
  updatedAt: number
  matches: Array<{
    messageIndex: number
    role: 'user' | 'assistant'
    snippet: string
  }>
}

export interface SessionRead {
  sessionId: string
  title: string
  providerId: string
  updatedAt: number
  messages: DisplayMessage[]
}

export interface SessionStateRead extends SessionRead {
  state: AgentState | null
}

export interface ListSessionsRequest {
  limit?: number
  offset?: number
  since?: number
  until?: number
}

export interface SearchSessionsRequest {
  pattern: string
  ignoreCase?: boolean
  literal?: boolean
  limit?: number
  matchesPerSession?: number
  since?: number
  until?: number
}

interface AgentSessionManagerDeps {
  runtimeRoot: string
  providerRegistry: ProviderRegistry
  getJsRuntime: () => JsRuntime
  busPublish: (topic: string, data: unknown) => void
  /** Optional — when absent, completion notifications are silently skipped. */
  notificationHost?: NotificationHost
}

export class AgentSessionManager {
  private sessions = new Map<string, SessionEntry>()
  private listeners = new Set<() => void>()
  private agentEventListeners = new Set<AgentEventListener>()
  private sessionLifecycleListeners = new Set<SessionLifecycleHandlers>()
  private readonly deps: AgentSessionManagerDeps
  private readonly sessionsDir: string

  // Cached state for the active (displayed) session
  private _activeSessionFile: string | null = null
  private _activeSessionId: string | null = null
  private _activeMessages: DisplayMessage[] = []
  private _activeLabel: string = ''
  private _activeNotifyOnFinish = false
  private _activeProviderId: string = ''

  constructor(deps: AgentSessionManagerDeps) {
    this.deps = deps
    this.sessionsDir = `${deps.runtimeRoot}/${DEFAULT_SESSION_DIR}`
  }

  get activeSessionFile(): string | null {
    return this._activeSessionFile
  }

  get activeAgent(): AgentWFYAgent | null {
    if (!this._activeSessionId) return null
    return this.sessions.get(this._activeSessionId)?.agent ?? null
  }

  get activeMessages(): DisplayMessage[] {
    const agent = this.activeAgent
    if (agent) return agent.messages
    return this._activeMessages
  }

  get activeIsStreaming(): boolean {
    const agent = this.activeAgent
    return agent?.isStreaming ?? false
  }

  get activeLabel(): string {
    return this._activeLabel
  }

  get activeNotifyOnFinish(): boolean {
    return this._activeNotifyOnFinish
  }

  get streamingSessionsCount(): number {
    let count = 0
    for (const [, entry] of this.sessions) {
      if (entry.agent.isStreaming) count++
    }
    return count
  }

  async createSession(opts: { label?: string; prompt: string; providerId?: string; files?: FileContent[] }): Promise<string> {
    await this.newSession(opts.providerId)

    if (opts.label) {
      this._activeLabel = opts.label
      const entry = this._activeSessionId ? this.sessions.get(this._activeSessionId) : null
      if (entry) entry.label = opts.label
    }

    const agent = this.activeAgent!
    agent.prompt(opts.prompt, { files: opts.files }).catch((err) => {
      console.error('[AgentSessionManager] auto-prompt failed', err)
    })

    return agent.sessionId
  }

  resetActive(): void {
    this._activeSessionFile = null
    this._activeSessionId = null
    this._activeMessages = []
    this._activeLabel = ''
    this._activeNotifyOnFinish = false
    this._activeProviderId = ''
    this.notify()
  }

  async sendMessage(text: string, options?: { streamingBehavior?: 'followUp'; files?: FileContent[] }): Promise<void> {
    // If the active session has an agent in memory, send directly
    const activeAgent = this.activeAgent
    if (activeAgent) {
      const behavior = options?.streamingBehavior ?? (activeAgent.isStreaming ? 'followUp' : undefined)
      await activeAgent.prompt(text, { streamingBehavior: behavior, files: options?.files })
      return
    }

    // No agent in memory — create one on demand
    if (!this._activeSessionFile) {
      throw new Error('No active session')
    }

    // Only pass sessionFile if it exists on disk (has messages)
    const hasExistingSession = this._activeMessages.length > 0
    const agent = await this.createAgentInstance(
      hasExistingSession
        ? { sessionFile: this._activeSessionFile, providerId: this._activeProviderId || undefined }
        : { providerId: this._activeProviderId || undefined }
    )
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, this._activeLabel)
    entry.notifyOnFinish = this._activeNotifyOnFinish
    this._activeSessionId = sessionId
    this._activeSessionFile = agent.sessionFile ?? this._activeSessionFile

    this.notify()

    await agent.prompt(text, { files: options?.files })
  }

  async abortActive(): Promise<void> {
    const agent = this.activeAgent
    if (!agent || !agent.isStreaming) return
    await agent.abort()
  }

  skipRetryDelay(): void {
    const agent = this.activeAgent
    if (agent) agent.agent.skipRetryDelay()
  }

  async loadSessionFromDisk(file: string): Promise<void> {
    const sessionsDir = this.sessionsDir
    const raw = await readSessionFile(sessionsDir, file)
    const stored = parseStoredSession(raw, file)

    const providerId = stored.providerId || await this.readDefaultProviderId()
    const messages = this.restoreMessages(stored, providerId)

    this._activeSessionFile = file
    this._activeSessionId = stored.sessionId || null
    this._activeMessages = messages
    this._activeLabel = stored.title || 'Session'
    this._activeNotifyOnFinish = false
    this._activeProviderId = providerId

    this.notify()
  }

  async closeActiveSession(): Promise<void> {
    if (this._activeSessionId) {
      await this.disposeSession(this._activeSessionId)
    }
    this.resetActive()
  }

  setNotifyOnFinish(value: boolean): void {
    this._activeNotifyOnFinish = value
    if (this._activeSessionId) {
      const entry = this.sessions.get(this._activeSessionId)
      if (entry) {
        entry.notifyOnFinish = value
      }
    }
    this.notify()
  }

  switchTo(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    // Switch to a currently-streaming session
    this._activeSessionId = sessionId
    this._activeSessionFile = entry.agent.sessionFile ?? this._activeSessionFile
    this._activeLabel = entry.label
    this._activeNotifyOnFinish = entry.notifyOnFinish ?? false
    this._activeProviderId = entry.agent.providerId
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to typed agent events from every tracked session (current and future). */
  subscribeToAgentEvents(listener: AgentEventListener): () => void {
    this.agentEventListeners.add(listener)
    return () => this.agentEventListeners.delete(listener)
  }

  /** Subscribe to in-memory disposal and persisted-session removal events. */
  subscribeToSessionLifecycle(handlers: SessionLifecycleHandlers): () => void {
    this.sessionLifecycleListeners.add(handlers)
    return () => this.sessionLifecycleListeners.delete(handlers)
  }

  getSessionFileForSessionId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.agent.sessionFile ?? null
  }

  /** Abort a specific session by id. No-op if the session isn't tracked or isn't streaming. */
  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId) ??
      [...this.sessions.values()].find((candidate) => candidate.agent.sessionFile === sessionId)
    if (!entry) return
    if (entry.agent.isStreaming) {
      await entry.agent.abort()
    }
  }

  /** Dispose the in-memory session (if any) and delete its on-disk file. */
  async removeSession(sessionId: string): Promise<void> {
    let entryId: string | null = this.sessions.has(sessionId) ? sessionId : null
    let entry = entryId ? this.sessions.get(entryId) : undefined
    if (!entry) {
      for (const [id, candidate] of this.sessions) {
        if (candidate.agent.sessionFile === sessionId) {
          entryId = id
          entry = candidate
          break
        }
      }
    }
    const sessionFile = entry?.agent.sessionFile ?? sessionId
    const removedEvent = {
      sessionId: entryId ?? sessionId,
      publicSessionId: sessionFile,
    }
    if (entry) {
      await this.disposeSession(entryId!)
    }
    if (sessionFile) {
      await deleteSessionFile(this.sessionsDir, sessionFile)
    }
    this.emitSessionRemoved(removedEvent)
  }

  async spawnSession(prompt: string, providerId?: string, providerOptions?: Record<string, unknown>): Promise<{ sessionId: string }> {
    const agent = await this.createAgentInstance({ providerId })
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, 'Spawned session')
    entry.autoPublishResponse = true
    this.notify()

    agent.prompt(prompt, { providerOptions }).catch((err) => {
      console.error('[AgentSessionManager] spawn-prompt failed', err)
    })

    return { sessionId: agent.sessionFile! }
  }

  async sendToSession(sessionFile: string, message: string): Promise<void> {
    // Check if this session is already in memory (streaming or idle)
    for (const [, entry] of this.sessions) {
      if (entry.agent.sessionFile === sessionFile) {
        await entry.agent.prompt(message, { streamingBehavior: 'followUp' })
        return
      }
    }

    // Load from disk and send
    const agent = await this.createAgentInstance({ sessionFile })
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, 'sendToSession')
    entry.autoPublishResponse = true
    this.notify()

    await agent.prompt(message)
  }

  async openSessionInChat(sessionFile: string): Promise<{ label: string }> {
    // If it's currently streaming in memory, switch to it
    for (const [id, entry] of this.sessions) {
      if (entry.agent.sessionFile === sessionFile) {
        this.switchTo(id)
        return { label: entry.label }
      }
    }
    // Otherwise load from disk
    await this.loadSessionFromDisk(sessionFile)
    return { label: this._activeLabel }
  }

  /** Create a new empty session (no prompt). Returns the session file. */
  async newSession(providerId?: string): Promise<string | null> {
    const pid = providerId || await this.readDefaultProviderId()

    const agent = await this.createAgentInstance({ providerId: pid })
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    this.trackSession(sessionId, agent, 'New session')
    this._activeSessionFile = agent.sessionFile ?? null
    this._activeSessionId = sessionId
    this._activeMessages = []
    this._activeLabel = 'New session'
    this._activeNotifyOnFinish = false
    this._activeProviderId = pid

    this.notify()
    return agent.sessionFile ?? null
  }

  /** Returns true if the current active session has no messages (is empty/fresh). */
  get activeIsEmpty(): boolean {
    const agent = this.activeAgent
    if (agent) return agent.messages.length === 0 && !agent.isStreaming
    return this._activeMessages.length === 0
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      await this.disposeSession(id)
    }
    this.resetActive()
    this.listeners.clear()
  }

  async getSessionList(): Promise<SessionListItem[]> {
    let history: SessionHistoryItem[] = []
    try {
      history = await this.listSessionHistory()
    } catch {
      history = []
    }

    const activeFile = this._activeSessionFile
    const streamingFiles = new Map<string, string>()
    for (const [id, entry] of this.sessions) {
      const file = entry.agent.sessionFile
      if (file && entry.agent.isStreaming) streamingFiles.set(file, id)
    }

    const items: SessionListItem[] = []

    for (const h of history) {
      const streamingId = streamingFiles.get(h.file)
      const isAct = h.file === activeFile
      items.push({
        label: h.firstUserMessage,
        updatedAt: h.updatedAt,
        isActive: isAct,
        isStreaming: !!streamingId,
        file: h.file,
        sessionId: streamingId ?? null,
      })
    }

    // Streaming sessions not yet saved to disk
    for (const [id, entry] of this.sessions) {
      const file = entry.agent.sessionFile
      if (entry.agent.isStreaming && (!file || !history.some(h => h.file === file))) {
        items.push({
          label: entry.label || 'New session',
          updatedAt: Date.now(),
          isActive: false,
          isStreaming: true,
          file: null,
          sessionId: id,
        })
      }
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  }

  // --- Snapshot for IPC ---

  getSnapshot(): AgentSnapshot {
    const agent = this.activeAgent
    const streamingFiles: string[] = []
    for (const [, entry] of this.sessions) {
      if (entry.agent.isStreaming && entry.agent.sessionFile) {
        streamingFiles.push(entry.agent.sessionFile)
      }
    }
    return {
      messages: this.activeMessages,
      isStreaming: this.activeIsStreaming,
      label: this._activeLabel,
      streamingSessionsCount: this.streamingSessionsCount,
      notifyOnFinish: this._activeNotifyOnFinish,
      streamingMessage: agent?.state.streamingMessage ?? null,
      statusLine: agent?.state.statusLine,
      providerId: this._activeProviderId,
      activeSessionFile: this._activeSessionFile,
      activeSessionId: agent?.sessionId ?? this._activeSessionId,
      streamingFiles,
      retryState: agent?.state.retryState ?? null,
      stalledSince: agent?.state.stalledSince ?? null,
    }
  }

  private async readDefaultProviderId(): Promise<string> {
    const { runtimeRoot } = this.deps
    try {
      const parsed = parseRunSqlRequest({
        target: 'agent',
        sql: `SELECT value FROM config WHERE name = '${SystemConfigKeys.provider}'`,
      })
      const rows = await routeSqlRequest(runtimeRoot, parsed) as Array<{ value: string }>
      if (rows[0]?.value) return rows[0].value
    } catch (err) {
      console.warn('[AgentSessionManager] failed to read default provider ID:', err)
    }
    return 'openai-compatible'
  }

  private async createAgentInstance(opts: { sessionFile?: string; providerId?: string }): Promise<AgentWFYAgent> {
    const { runtimeRoot, providerRegistry, getJsRuntime } = this.deps
    let providerId = opts.providerId || await this.readDefaultProviderId()

    // When restoring a session, read the file once and use the provider that created it
    let storedSession: ReturnType<typeof parseStoredSession> | undefined
    if (opts.sessionFile) {
      try {
        const raw = await readSessionFile(this.sessionsDir, opts.sessionFile)
        storedSession = parseStoredSession(raw, opts.sessionFile)
        if (storedSession.providerId && providerRegistry.get(storedSession.providerId)) {
          providerId = storedSession.providerId
        }
      } catch (err) {
        console.warn('[AgentSessionManager] failed to read stored session for provider:', err)
      }
    }

    const factory = providerRegistry.get(providerId)
    if (!factory) throw new Error(`Provider '${providerId}' not found`)

    return AgentWFYAgent.create({
      createProviderSession: (config) => {
        return factory.createSession({ ...config, tools: [EXECJS_TOOL_DEFINITION] })
      },
      restoreProviderSession: (config, state) => {
        return factory.restoreSession({ ...config, tools: [EXECJS_TOOL_DEFINITION] }, state)
      },
      providerId,
      runtimeRoot,
      getJsRuntime,
      ...(opts.sessionFile ? { sessionFile: opts.sessionFile, storedSession } : {}),
    })
  }

  private trackSession(sessionId: string, agent: AgentWFYAgent, label: string): SessionEntry {
    const entry: SessionEntry = {
      agent,
      label,
      unsubscribe: () => {},
      agentEventUnsubscribe: () => {},
      wasStreaming: false,
    }
    entry.agentEventUnsubscribe = agent.subscribe((event) => {
      for (const fn of this.agentEventListeners) {
        try {
          fn(sessionId, event)
        } catch (err) {
          console.error('[AgentSessionManager] agent event listener threw:', err)
        }
      }
    })
    entry.unsubscribe = agent.subscribe(() => {
      if (entry.label === 'New session' || entry.label === 'Spawned session' || entry.label === 'sendToSession') {
        const userLabel = extractFirstUserMessage(agent.messages, 60)
        if (userLabel) {
          entry.label = userLabel
          if (sessionId === this._activeSessionId) {
            this._activeLabel = userLabel
          }
        }
      }
      // Update label when the provider generates a title (e.g. via summarization)
      const providerTitle = agent.agent.getProviderTitle()
      if (providerTitle && providerTitle !== entry.label) {
        const userLabel = extractFirstUserMessage(agent.messages, 60)
        // Only update if the provider title differs from the first-message fallback
        if (providerTitle !== userLabel) {
          entry.label = providerTitle
          if (sessionId === this._activeSessionId) {
            this._activeLabel = providerTitle
          }
        }
      }
      const wasStreaming = entry.wasStreaming
      entry.wasStreaming = agent.isStreaming
      if (wasStreaming && !agent.isStreaming) {
        this.handleStreamingFinished(sessionId, entry)
      }
      this.notify()
    })

    this.sessions.set(sessionId, entry)
    return entry
  }

  private handleStreamingFinished(sessionId: string, entry: SessionEntry): void {
    if (entry.notifyOnFinish && this.deps.notificationHost) {
      try {
        this.deps.notificationHost.show({ title: 'Agent finished', body: entry.label })
      } catch {
        // Notifications may not be supported
      }
      this.deps.notificationHost.bounce?.()
    }

    // Auto-publish response for spawned/sendToSession sessions
    if (entry.autoPublishResponse) {
      const lastMsg = getLastAssistantMessage(entry.agent.messages)
      const lastText = lastMsg ? getTextFromDisplayMessage(lastMsg) : ''
      const sessionFile = entry.agent.sessionFile
      if (sessionFile) {
        this.deps.busPublish(`session:response:${sessionFile}`, { sessionId: sessionFile, response: lastText })
      }

      // Dispose spawned/background sessions immediately
      void this.disposeSession(sessionId)
      return
    }

    // Regular sessions: keep alive until explicitly closed
  }

  private async disposeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    const publicSessionId = entry.agent.sessionFile ?? sessionId

    if (entry.agent.isStreaming) {
      await entry.agent.abort()
    }

    if (sessionId === this._activeSessionId) {
      this._activeMessages = [...entry.agent.messages]
      this._activeSessionId = null
    }

    this.deps.getJsRuntime().terminateWorker(sessionId)
    entry.unsubscribe()
    entry.agentEventUnsubscribe()
    entry.agent.dispose()
    this.sessions.delete(sessionId)
    this.emitSessionDisposed({ sessionId, publicSessionId })

    this.notify()
  }

  private emitSessionDisposed(event: SessionLifecycleEvent): void {
    for (const handlers of this.sessionLifecycleListeners) {
      try {
        handlers.onDisposed?.(event)
      } catch (err) {
        console.error('[AgentSessionManager] session dispose listener threw:', err)
      }
    }
  }

  private emitSessionRemoved(event: SessionLifecycleEvent): void {
    for (const handlers of this.sessionLifecycleListeners) {
      try {
        handlers.onRemoved?.(event)
      } catch (err) {
        console.error('[AgentSessionManager] session remove listener threw:', err)
      }
    }
  }

  async listSessions(request: ListSessionsRequest = {}): Promise<SessionSummary[]> {
    const limit = request.limit ?? 20
    const offset = request.offset ?? 0
    if (!Number.isFinite(limit) || limit < 1) throw new Error('listSessions limit must be >= 1')
    if (!Number.isFinite(offset) || offset < 0) throw new Error('listSessions offset must be >= 0')

    const all = await listSessionFiles(this.sessionsDir)
    const filtered = (request.since === undefined && request.until === undefined)
      ? all
      : all.filter((s) =>
          (request.since === undefined || s.updatedAt >= request.since) &&
          (request.until === undefined || s.updatedAt <= request.until))
    const page = filtered.slice(offset, offset + limit)

    return Promise.all(page.map(async (session) => {
      const meta = await readSessionMeta(this.sessionsDir, session.name)
      return {
        sessionId: session.name,
        title: meta.title,
        providerId: meta.providerId,
        updatedAt: session.updatedAt,
      }
    }))
  }

  async searchSessions(request: SearchSessionsRequest): Promise<SessionMatch[]> {
    const limit = request.limit ?? 10
    const matchesPerSession = request.matchesPerSession ?? 5
    if (!Number.isFinite(limit) || limit < 1) throw new Error('searchSessions limit must be >= 1')
    if (!Number.isFinite(matchesPerSession) || matchesPerSession < 1) {
      throw new Error('searchSessions matchesPerSession must be >= 1')
    }

    const source = request.literal ? escapeRegex(request.pattern) : request.pattern
    let regex: RegExp
    try {
      regex = new RegExp(source, request.ignoreCase ? 'i' : '')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid regex: ${msg}`)
    }

    const all = await listSessionFiles(this.sessionsDir)
    const results: SessionMatch[] = []

    for (const session of all) {
      if (request.since !== undefined && session.updatedAt < request.since) continue
      if (request.until !== undefined && session.updatedAt > request.until) continue
      const match = await this.searchSessionFile(session.name, session.updatedAt, regex, matchesPerSession)
      if (match) results.push(match)
      if (results.length >= limit) break
    }

    return results
  }

  private async searchSessionFile(
    file: string,
    updatedAt: number,
    regex: RegExp,
    matchesPerSession: number,
  ): Promise<SessionMatch | null> {
    let stored: StoredSession
    try {
      const raw = await readSessionFile(this.sessionsDir, file)
      stored = parseStoredSession(raw, file)
    } catch (err) {
      console.warn('[AgentSessionManager] searchSessions: skipping', file, err)
      return null
    }

    const messages = this.restoreMessages(stored, stored.providerId)
    if (messages.length === 0) return null

    const matches: SessionMatch['matches'] = []
    for (const item of displayMessagesToSearchText(messages)) {
      if (matches.length >= matchesPerSession) break
      const m = regex.exec(item.text)
      if (!m) continue
      matches.push({
        messageIndex: item.messageIndex,
        role: item.role,
        snippet: makeSnippet(item.text, m.index, m[0].length),
      })
    }
    if (matches.length === 0) return null

    return { sessionId: file, title: stored.title, updatedAt, matches }
  }

  async readSession(sessionId: string): Promise<SessionRead> {
    const raw = await readSessionFile(this.sessionsDir, sessionId)
    const stored = parseStoredSession(raw, sessionId)
    const providerId = stored.providerId || await this.readDefaultProviderId()
    return {
      sessionId,
      title: stored.title,
      providerId,
      updatedAt: stored.updatedAt,
      messages: stripBlockBinaries(this.restoreMessages(stored, providerId)),
    }
  }

  async readSessionState(sessionId: string): Promise<SessionStateRead> {
    const live = this.getLiveSessionState(sessionId)
    if (live) return live
    return {
      ...await this.readSession(sessionId),
      state: null,
    }
  }

  /** Returns the live agent state reference (not a clone). Callers that
   *  serialize this must apply `stripBlockBinaries` / `sanitizeStreamingMessage`
   *  themselves. Used by the hot streaming path which needs reference identity
   *  on `state.messages` to detect when the committed-message array changed. */
  getSessionAgentState(sessionId: string): AgentState | null {
    const entry = this.findSessionEntry(sessionId)
    return entry?.agent.state ?? null
  }

  getSessionTitle(sessionId: string): string | null {
    const entry = this.findSessionEntry(sessionId)
    return entry?.label ?? null
  }

  private getLiveSessionState(sessionId: string): SessionStateRead | null {
    const found = this.findSessionEntryWithId(sessionId)
    if (!found) return null
    const { publicSessionId, entry } = found
    const agentState = sanitizeAgentState(entry.agent.state)
    return {
      sessionId: publicSessionId,
      title: entry.label || extractFirstUserMessage(entry.agent.messages, 60) || 'New session',
      providerId: entry.agent.providerId,
      updatedAt: Date.now(),
      messages: agentState.messages,
      state: agentState,
    }
  }

  private findSessionEntry(sessionId: string): SessionEntry | null {
    return this.findSessionEntryWithId(sessionId)?.entry ?? null
  }

  private findSessionEntryWithId(sessionId: string): { publicSessionId: string; entry: SessionEntry } | null {
    const direct = this.sessions.get(sessionId)
    if (direct) {
      return { publicSessionId: direct.agent.sessionFile ?? sessionId, entry: direct }
    }
    for (const [id, entry] of this.sessions) {
      if (entry.agent.sessionFile === sessionId) {
        return { publicSessionId: entry.agent.sessionFile ?? id, entry }
      }
    }
    return null
  }

  private restoreMessages(stored: StoredSession, providerId: string): DisplayMessage[] {
    const factory = this.deps.providerRegistry.get(providerId)
    if (!factory || !stored.providerState) return []
    const session = factory.restoreSession(
      { sessionId: stored.sessionId, systemPrompt: '', tools: [] },
      stored.providerState,
    )
    try {
      return session.getDisplayMessages()
    } finally {
      session.dispose()
    }
  }

  async disposeSessionByFile(file: string): Promise<void> {
    for (const [id, entry] of this.sessions) {
      if (entry.agent.sessionFile === file) {
        await this.disposeSession(id)
        return
      }
    }
  }

  private _notifyScheduled = false

  private notify(): void {
    if (this._notifyScheduled) return
    this._notifyScheduled = true
    setTimeout(() => {
      this._notifyScheduled = false
      for (const listener of this.listeners) {
        try {
          listener()
        } catch (err) {
          console.error('[AgentSessionManager] listener error', err)
        }
      }
    }, 0)
  }

  private async listSessionHistory(): Promise<SessionHistoryItem[]> {
    const sessionsDir = this.sessionsDir

    try {
      const sessions = await listSessionFiles(sessionsDir)
      if (sessions.length === 0) return []

      const results = await Promise.all(sessions.map(async (session) => {
        if (!session.name.endsWith('.json')) return null
        const title = await readSessionTitle(sessionsDir, session.name)
        if (!title) return null
        return { file: session.name, updatedAt: session.updatedAt, firstUserMessage: title }
      }))

      const items: SessionHistoryItem[] = results.filter((r): r is SessionHistoryItem => r !== null)
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      return items
    } catch {
      return []
    }
  }
}
