import { Notification, type BrowserWindow } from 'electron'
import { AgentWFYAgent, DEFAULT_SESSION_DIR } from './create_agent.js'
import type { DisplayMessage } from './provider_types.js'
import { EXECJS_TOOL_DEFINITION } from './provider_types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import { forwardBusPublish } from '../ipc/bus.js'
import {
  createSessionFileName,
  readSessionFile,
  listSessionFiles,
  parseStoredSession,
} from './session_persistence.js'

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

export interface SessionEntry {
  agent: AgentWFYAgent
  label: string
  unsubscribe: () => void
  wasStreaming?: boolean
  notifyOnFinish?: boolean
  autoPublishResponse?: boolean
}

export interface SessionHistoryItem {
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

export interface AgentSessionManagerDeps {
  agentRoot: string
  win: BrowserWindow
  providerRegistry: ProviderRegistry
  getJsRuntime: () => JsRuntime
}

export class AgentSessionManager {
  private sessions = new Map<string, SessionEntry>()
  private listeners = new Set<() => void>()
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
    this.sessionsDir = `${deps.agentRoot}/${DEFAULT_SESSION_DIR}`
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

  async createSession(opts?: { label?: string; prompt?: string; providerId?: string }): Promise<string> {
    const sessionFile = createSessionFileName()
    const label = opts?.label || 'New session'
    const providerId = opts?.providerId || await this.readDefaultProviderId()

    if (opts?.prompt) {
      // Create agent immediately and start streaming
      const agent = await this.createAgentInstance({ sessionFile, providerId })
      const sessionId = agent.sessionId
      this.deps.getJsRuntime().ensureWorker(sessionId)

      const entry = this.trackSession(sessionId, agent, label)
      this._activeSessionFile = agent.sessionFile ?? sessionFile
      this._activeSessionId = sessionId
      this._activeMessages = []
      this._activeLabel = label
      this._activeNotifyOnFinish = false
      this._activeProviderId = providerId

      this.notify()

      agent.prompt(opts.prompt).catch((err) => {
        console.error('[AgentSessionManager] auto-prompt failed', err)
      })

      return sessionId
    }

    // No prompt — just set up empty active state
    this._activeSessionFile = sessionFile
    this._activeSessionId = null
    this._activeMessages = []
    this._activeLabel = label
    this._activeProviderId = providerId

    this._activeNotifyOnFinish = false
    this.notify()

    return sessionFile
  }

  async sendMessage(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void> {
    // If the active session is currently streaming, send as followUp/steer
    const activeAgent = this.activeAgent
    if (activeAgent) {
      const behavior = options?.streamingBehavior ?? (activeAgent.isStreaming ? 'followUp' : undefined)
      await activeAgent.prompt(text, { streamingBehavior: behavior })
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

    await agent.prompt(text)
  }

  async abortActive(): Promise<void> {
    const agent = this.activeAgent
    if (!agent || !agent.isStreaming) return
    await agent.abort()
  }

  async loadSessionFromDisk(file: string): Promise<void> {
    const sessionsDir = this.sessionsDir
    const raw = await readSessionFile(sessionsDir, file)
    const stored = parseStoredSession(raw, file)

    this._activeSessionFile = file
    this._activeSessionId = null
    this._activeMessages = stored.messages
    this._activeLabel = extractFirstUserMessage(stored.messages, 60) ?? 'Session'
    this._activeNotifyOnFinish = false
    this._activeProviderId = stored.providerId || ''

    this.notify()
  }

  async closeActiveSession(): Promise<void> {
    const agent = this.activeAgent
    if (agent) {
      if (agent.isStreaming) {
        await agent.abort()
      }
      const sessionId = this._activeSessionId!
      this.deps.getJsRuntime().terminateWorker(sessionId)
      const entry = this.sessions.get(sessionId)
      if (entry) {
        entry.unsubscribe()
        entry.agent.dispose()
        this.sessions.delete(sessionId)
      }
    }

    this._activeSessionFile = null
    this._activeSessionId = null
    this._activeMessages = []
    this._activeLabel = ''
    this._activeNotifyOnFinish = false
    this._activeProviderId = ''

    this.notify()
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

  async spawnSession(prompt: string): Promise<{ agentId: string }> {
    const agent = await this.createAgentInstance({})
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, 'Spawned agent')
    entry.autoPublishResponse = true
    this.notify()

    agent.prompt(prompt).catch((err) => {
      console.error('[AgentSessionManager] spawn-prompt failed', err)
    })

    // Return the session file as the durable agentId
    return { agentId: agent.sessionFile! }
  }

  async sendToAgent(agentId: string, message: string): Promise<void> {
    // agentId is a session file name
    // Check if this agent is already streaming in memory
    for (const [, entry] of this.sessions) {
      if (entry.agent.sessionFile === agentId) {
        await entry.agent.prompt(message, { streamingBehavior: 'followUp' })
        return
      }
    }

    // Load from disk and send
    const agent = await this.createAgentInstance({ sessionFile: agentId })
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, 'sendToAgent')
    entry.autoPublishResponse = true
    this.notify()

    await agent.prompt(message)
  }

  async disposeAll(): Promise<void> {
    for (const [, entry] of this.sessions) {
      if (entry.agent.isStreaming) {
        await entry.agent.abort()
      }
      this.deps.getJsRuntime().terminateWorker(entry.agent.sessionId)
      entry.unsubscribe()
      entry.agent.dispose()
    }

    this.sessions.clear()
    this._activeSessionFile = null
    this._activeSessionId = null
    this._activeMessages = []
    this._activeLabel = ''
    this._activeNotifyOnFinish = false
    this._activeProviderId = ''
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
      if (file) streamingFiles.set(file, id)
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
        file: streamingId ? null : h.file,
        sessionId: streamingId ?? null,
      })
    }

    // Streaming sessions not yet saved to disk
    for (const [id, entry] of this.sessions) {
      const file = entry.agent.sessionFile
      if (!file || !history.some(h => h.file === file)) {
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

  getSnapshot(): {
    messages: DisplayMessage[]
    isStreaming: boolean
    label: string
    streamingSessionsCount: number
    notifyOnFinish: boolean
    streamingMessage: DisplayMessage | null
    statusLine: string | undefined
    providerId: string
  } {
    const agent = this.activeAgent
    return {
      messages: this.activeMessages,
      isStreaming: this.activeIsStreaming,
      label: this._activeLabel,
      streamingSessionsCount: this.streamingSessionsCount,
      notifyOnFinish: this._activeNotifyOnFinish,
      streamingMessage: agent?.state.streamingMessage ?? null,
      statusLine: agent?.state.statusLine,
      providerId: this._activeProviderId,
    }
  }

  private async readDefaultProviderId(): Promise<string> {
    const { agentRoot } = this.deps
    try {
      const parsed = parseRunSqlRequest({
        target: 'agent',
        sql: "SELECT value FROM config WHERE name = 'system.provider'",
      })
      const rows = await routeSqlRequest(agentRoot, parsed) as Array<{ value: string }>
      if (rows[0]?.value) return JSON.parse(rows[0].value)
    } catch {}
    return 'openai-compatible'
  }

  private async createAgentInstance(opts: { sessionFile?: string; providerId?: string }): Promise<AgentWFYAgent> {
    const { agentRoot, providerRegistry, getJsRuntime } = this.deps
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
      } catch {}
    }

    const factory = providerRegistry.get(providerId)
    if (!factory) throw new Error(`Provider '${providerId}' not found`)

    return AgentWFYAgent.create({
      createProviderSession: (config) => {
        return factory.createSession({ ...config, tools: [EXECJS_TOOL_DEFINITION] })
      },
      restoreProviderSession: (messages, config, state) => {
        return factory.restoreSession(messages, { ...config, tools: [EXECJS_TOOL_DEFINITION] }, state)
      },
      providerId,
      agentRoot,
      getJsRuntime,
      ...(opts.sessionFile ? { sessionFile: opts.sessionFile, storedSession } : {}),
    })
  }

  private trackSession(sessionId: string, agent: AgentWFYAgent, label: string): SessionEntry {
    const entry: SessionEntry = { agent, label, unsubscribe: () => {}, wasStreaming: false }
    entry.unsubscribe = agent.subscribe(() => {
      if (entry.label === 'New session' || entry.label === 'Spawned agent' || entry.label === 'sendToAgent') {
        const userLabel = extractFirstUserMessage(agent.messages, 60)
        if (userLabel) {
          entry.label = userLabel
          if (sessionId === this._activeSessionId) {
            this._activeLabel = userLabel
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
    if (entry.notifyOnFinish) {
      try {
        new Notification({ title: 'Agent finished', body: entry.label }).show()
      } catch {
        // Notifications may not be supported
      }
    }

    // Auto-publish response for spawned/sendToAgent agents
    if (entry.autoPublishResponse) {
      const lastMsg = getLastAssistantMessage(entry.agent.messages)
      const lastText = lastMsg ? getTextFromDisplayMessage(lastMsg) : ''
      const agentId = entry.agent.sessionFile
      if (agentId && !this.deps.win.isDestroyed()) {
        forwardBusPublish(this.deps.win, `agent:response:${agentId}`, { agentId, response: lastText })
      }
    }

    // Cache active session messages before disposal
    if (sessionId === this._activeSessionId) {
      this._activeMessages = [...entry.agent.messages]
      this._activeSessionId = null
    }

    // Dispose
    this.deps.getJsRuntime().terminateWorker(sessionId)
    entry.unsubscribe()
    entry.agent.dispose()
    this.sessions.delete(sessionId)
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
      const sessions = await listSessionFiles(sessionsDir, 200)
      if (sessions.length === 0) return []

      const items: SessionHistoryItem[] = []

      for (const session of sessions) {
        if (!session.name.endsWith('.json')) continue

        try {
          const raw = await readSessionFile(sessionsDir, session.name)
          const parsed = JSON.parse(raw)
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : session.updatedAt
          const firstUserMessage = extractFirstUserMessage(parsed.messages, 100) ?? ''

          if (firstUserMessage) {
            items.push({ file: session.name, updatedAt, firstUserMessage })
          }
        } catch {
          // Skip unparseable files
        }
      }

      items.sort((a, b) => b.updatedAt - a.updatedAt)
      return items.slice(0, 50)
    } catch {
      return []
    }
  }
}
