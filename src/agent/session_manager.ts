import { Notification, nativeImage, type BrowserWindow } from 'electron'
import path from 'path'
import { AgentWFYAgent, DEFAULT_SESSION_DIR } from './create_agent.js'
import type { DisplayMessage } from './provider_types.js'
import { EXECJS_TOOL_DEFINITION } from './provider_types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import { forwardBusPublish } from '../ipc/bus.js'
import {
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

interface SessionEntry {
  agent: AgentWFYAgent
  label: string
  unsubscribe: () => void
  wasStreaming?: boolean
  notifyOnFinish?: boolean
  autoPublishResponse?: boolean
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

interface AgentSessionManagerDeps {
  agentRoot: string
  win: BrowserWindow
  providerRegistry: ProviderRegistry
  getJsRuntime: () => JsRuntime
  busPublish?: (topic: string, data: unknown) => void
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

  async createSession(opts: { label?: string; prompt: string; providerId?: string }): Promise<string> {
    const label = opts.label || 'New session'
    const providerId = opts.providerId || await this.readDefaultProviderId()

    const agent = await this.createAgentInstance({ providerId })
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    this.trackSession(sessionId, agent, label)
    this._activeSessionFile = agent.sessionFile ?? null
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

  resetActive(): void {
    this._activeSessionFile = null
    this._activeSessionId = null
    this._activeMessages = []
    this._activeLabel = ''
    this._activeNotifyOnFinish = false
    this._activeProviderId = ''
    this.notify()
  }

  async sendMessage(text: string, options?: { streamingBehavior?: 'followUp' }): Promise<void> {
    // If the active session has an agent in memory, send directly
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

    const providerId = stored.providerId || await this.readDefaultProviderId()
    const factory = this.deps.providerRegistry.get(providerId)

    let messages: DisplayMessage[] = []
    if (factory && stored.providerState) {
      const session = factory.restoreSession(
        { sessionId: stored.sessionId, systemPrompt: '', tools: [] },
        stored.providerState,
      )
      const result = session.getDisplayMessages()
      messages = result instanceof Promise ? await result : result
    }

    this._activeSessionFile = file
    this._activeSessionId = null
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

  async spawnSession(prompt: string): Promise<{ sessionId: string }> {
    const agent = await this.createAgentInstance({})
    const sessionId = agent.sessionId
    this.deps.getJsRuntime().ensureWorker(sessionId)

    const entry = this.trackSession(sessionId, agent, 'Spawned agent')
    entry.autoPublishResponse = true
    this.notify()

    agent.prompt(prompt).catch((err) => {
      console.error('[AgentSessionManager] spawn-prompt failed', err)
    })

    return { sessionId: agent.sessionFile! }
  }

  async sendToAgent(sessionFile: string, message: string): Promise<void> {
    // Check if this agent is already in memory (streaming or idle)
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

    const entry = this.trackSession(sessionId, agent, 'sendToAgent')
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

  getSnapshot(): {
    messages: DisplayMessage[]
    isStreaming: boolean
    label: string
    streamingSessionsCount: number
    notifyOnFinish: boolean
    streamingMessage: DisplayMessage | null
    statusLine: string | undefined
    providerId: string
    activeSessionFile: string | null
    streamingFiles: string[]
  } {
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
      streamingFiles,
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
      if (rows[0]?.value) return rows[0].value
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
      restoreProviderSession: (config, state) => {
        return factory.restoreSession({ ...config, tools: [EXECJS_TOOL_DEFINITION] }, state)
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
    if (entry.notifyOnFinish) {
      try {
        const icon = nativeImage.createFromPath(path.join(import.meta.dirname, '..', '..', 'icons', 'icon.png'))
        new Notification({ title: 'Agent finished', body: entry.label, icon }).show()
      } catch {
        // Notifications may not be supported
      }
    }

    // Auto-publish response for spawned/sendToAgent agents
    if (entry.autoPublishResponse) {
      const lastMsg = getLastAssistantMessage(entry.agent.messages)
      const lastText = lastMsg ? getTextFromDisplayMessage(lastMsg) : ''
      const sessionFile = entry.agent.sessionFile
      if (sessionFile && !this.deps.win.isDestroyed()) {
        const publish = this.deps.busPublish ?? ((topic: string, data: unknown) => forwardBusPublish(this.deps.win, topic, data))
        publish(`agent:response:${sessionFile}`, { sessionId: sessionFile, response: lastText })
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

    if (entry.agent.isStreaming) {
      await entry.agent.abort()
    }

    if (sessionId === this._activeSessionId) {
      this._activeMessages = [...entry.agent.messages]
      this._activeSessionId = null
    }

    this.deps.getJsRuntime().terminateWorker(sessionId)
    entry.unsubscribe()
    entry.agent.dispose()
    this.sessions.delete(sessionId)

    this.notify()
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
      const sessions = await listSessionFiles(sessionsDir, 200)
      if (sessions.length === 0) return []

      const items: SessionHistoryItem[] = []

      for (const session of sessions) {
        if (!session.name.endsWith('.json')) continue

        try {
          const raw = await readSessionFile(sessionsDir, session.name)
          const parsed = JSON.parse(raw)
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : session.updatedAt
          const title = typeof parsed.title === 'string' ? parsed.title : ''

          if (title) {
            items.push({ file: session.name, updatedAt, firstUserMessage: title })
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
