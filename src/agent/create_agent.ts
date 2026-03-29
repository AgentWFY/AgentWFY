import { Agent } from './index.js'
import type { AgentEvent, AgentState, FileContent } from './types.js'
import { createExecJsTool } from './exec_js.js'
import {
  SESSION_VERSION,
  type StoredSession,
  createSessionId,
  createSessionFileName,
  normalizeSessionFileName,
  parseStoredSession,
  readSessionFile,
  writeSessionFile,
  ensureSessionsDir,
} from './session_persistence.js'
import type { ProviderSession, DisplayMessage } from './provider_types.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'

export const DEFAULT_SESSION_DIR = '.agentwfy/sessions'

const FALLBACK_SYSTEM_PROMPT = 'You are the AgentWFY desktop AI agent. Your docs failed to load from the database — check the docs table in agent.db.'

interface SessionConfig {
  sessionId: string
  systemPrompt: string
}

type ProviderSessionFactory = (config: SessionConfig) => ProviderSession | Promise<ProviderSession>
type ProviderSessionRestorer = (config: SessionConfig, state: unknown) => ProviderSession | Promise<ProviderSession>

export interface AgentWFYAgentOptions {
  createProviderSession: ProviderSessionFactory
  restoreProviderSession: ProviderSessionRestorer
  providerId: string
  sessionFile?: string
  storedSession?: StoredSession
  persistSessions?: boolean
  agentRoot: string
  getJsRuntime: () => JsRuntime
}

export interface AgentWFYAgentPromptOptions {
  files?: FileContent[]
  streamingBehavior?: 'followUp'
}

export type AgentWFYAgentEvent = AgentEvent | {
  type: 'session_saved'
  sessionId: string
  sessionFile: string
} | {
  type: 'session_loaded'
  sessionId: string
  sessionFile: string
}

export type AgentWFYAgentEventListener = (event: AgentWFYAgentEvent) => void

function parsePreloadDocRows(rows: unknown): Array<{ name: string; content: string }> {
  if (!Array.isArray(rows)) {
    return []
  }

  const result: Array<{ name: string; content: string }> = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const doc = row as Record<string, unknown>
    if (typeof doc.name !== 'string' || typeof doc.content !== 'string') continue
    if (!doc.content.trim()) continue
    result.push({
      name: doc.name,
      content: doc.content,
    })
  }

  return result
}

function buildDocsPromptSection(rows: Array<{ name: string; content: string }>): string {
  return rows
    .map((row) => `## [${row.name}]\n${row.content.trim()}`)
    .join('\n\n')
    .trim()
}

async function loadSystemPrompt(agentRoot: string): Promise<string> {
  try {
    const parsed = parseRunSqlRequest({
      target: 'agent',
      sql: "SELECT name, content FROM docs WHERE name NOT LIKE '%.%' ORDER BY name ASC",
      description: 'Load preload docs for agent system prompt',
    })
    const rows = await routeSqlRequest(agentRoot, parsed)
    const docs = parsePreloadDocRows(rows)
    const promptSection = buildDocsPromptSection(docs)

    if (!promptSection) {
      console.warn('[agent] no preload docs found in agent.db, using fallback prompt')
      return FALLBACK_SYSTEM_PROMPT
    }

    return promptSection
  } catch (error) {
    console.warn('[agent] failed to load system prompt from DB, using fallback', error)
    return FALLBACK_SYSTEM_PROMPT
  }
}

function createTools(sessionIdRef: { current: string }, getJsRuntime: () => JsRuntime) {
  return [
    createExecJsTool({
      getSessionId: () => sessionIdRef.current,
      getJsRuntime,
    }),
  ]
}

export class AgentWFYAgent {
  readonly agent: Agent

  private readonly listeners = new Set<AgentWFYAgentEventListener>()
  private readonly unsubscribeFromAgent: () => void
  private readonly sessionsDir: string
  private readonly persistSessionsToDisk: boolean
  private readonly sessionIdRef: { current: string }
  private readonly createProviderSession: ProviderSessionFactory
  private readonly restoreProviderSession: ProviderSessionRestorer
  readonly providerId: string

  private systemPrompt: string
  private sessionWritePromise: Promise<void> = Promise.resolve()
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string

  private constructor(
    agent: Agent,
    sessionsDir: string,
    sessionFile: string | undefined,
    sessionId: string,
    sessionIdRef: { current: string },
    persistSessions: boolean,
    systemPrompt: string,
    createProviderSession: ProviderSessionFactory,
    restoreProviderSession: ProviderSessionRestorer,
    providerId: string,
  ) {
    this.agent = agent
    this.sessionsDir = sessionsDir
    this.persistSessionsToDisk = persistSessions
    this.sessionIdRef = sessionIdRef
    this._sessionFile = sessionFile
    this._sessionId = sessionId
    this.systemPrompt = systemPrompt
    this.createProviderSession = createProviderSession
    this.restoreProviderSession = restoreProviderSession
    this.providerId = providerId

    this.sessionIdRef.current = this._sessionId
    this.agent.sessionId = this._sessionId

    this.unsubscribeFromAgent = this.agent.subscribe((event) => {
      this.emit(event)

      if (event.type === 'agent_end' || event.type === 'state_changed') {
        void this.persistSession()
      }
    })
  }

  static async create(options: AgentWFYAgentOptions): Promise<AgentWFYAgent> {
    const agentRoot = options.agentRoot
    const sessionsDir = `${agentRoot}/${DEFAULT_SESSION_DIR}`
    const persistSessions = options.persistSessions ?? true

    if (persistSessions) {
      await ensureSessionsDir(sessionsDir)
    }

    const sessionId = createSessionId()
    const sessionIdRef = { current: sessionId }
    const systemPrompt = await loadSystemPrompt(agentRoot)
    const tools = createTools(sessionIdRef, options.getJsRuntime)
    const sessionFile = options.sessionFile
      ? normalizeSessionFileName(options.sessionFile)
      : (persistSessions ? createSessionFileName() : undefined)

    // If restoring from file, use restoreProviderSession with saved messages.
    // Otherwise, create a fresh provider session.
    let providerSession: ProviderSession
    let initialMessages: DisplayMessage[] = []

    if (options.sessionFile) {
      const stored = options.storedSession
        ?? parseStoredSession(await readSessionFile(sessionsDir, normalizeSessionFileName(options.sessionFile)), options.sessionFile)

      providerSession = await options.restoreProviderSession({
        sessionId: stored.sessionId || sessionId,
        systemPrompt,
      }, stored.providerState)

      // Provider is the source of truth for display messages
      initialMessages = providerSession.getDisplayMessages()
    } else {
      providerSession = await options.createProviderSession({
        sessionId,
        systemPrompt,
      })
    }

    const agent = new Agent({
      initialState: {
        systemPrompt,
        tools,
        messages: initialMessages,
      },
      providerSession,
      sessionId,
    })

    const instance = new AgentWFYAgent(
      agent,
      sessionsDir,
      sessionFile,
      options.sessionFile ? (initialMessages.length > 0 ? sessionId : createSessionId()) : sessionId,
      sessionIdRef,
      persistSessions,
      systemPrompt,
      options.createProviderSession,
      options.restoreProviderSession,
      options.providerId,
    )

    if (options.sessionFile) {
      instance.emit({
        type: 'session_loaded',
        sessionId: instance._sessionId,
        sessionFile: sessionFile!,
      })
    } else {
      await instance.persistSession()
    }

    return instance
  }

  get sessionFile(): string | undefined {
    return this._sessionFile
  }

  get sessionId(): string {
    return this._sessionId
  }

  get persistSessions(): boolean {
    return this.persistSessionsToDisk
  }

  get messages(): DisplayMessage[] {
    return this.agent.state.messages
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming
  }

  get state(): AgentState {
    return this.agent.state
  }

  async prompt(text: string, options: AgentWFYAgentPromptOptions = {}): Promise<void> {
    if (!text || !text.trim()) {
      throw new Error('Prompt cannot be empty')
    }

    if (this.isStreaming) {
      if (!options.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior: 'followUp' to queue the message.")
      }

      this.agent.followUp(text)
      return
    }

    await this.agent.prompt(text, options.files)
    await this.persistSession()
  }

  subscribe(listener: AgentWFYAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async newSession(): Promise<boolean> {
    await this.abort()
    this.agent.providerSession.dispose()
    this.agent.reset()

    const newId = createSessionId()
    this.updateSessionId(newId)

    // Create a fresh provider session
    const providerSession = await this.createProviderSession({
      sessionId: newId,
      systemPrompt: this.systemPrompt,
    })
    this.agent.setProviderSession(providerSession)

    if (this.persistSessionsToDisk) {
      this._sessionFile = createSessionFileName()
      await this.persistSession()
    } else {
      this._sessionFile = undefined
    }

    return true
  }

  async switchSession(sessionPath: string): Promise<boolean> {
    if (!sessionPath || !sessionPath.trim()) {
      throw new Error('Session path cannot be empty')
    }

    await this.abort()
    this.agent.providerSession.dispose()

    const sessionFileName = normalizeSessionFileName(sessionPath)
    const rawSession = await readSessionFile(this.sessionsDir, sessionFileName)
    const stored = parseStoredSession(rawSession, sessionFileName)

    const restoredSessionId = stored.sessionId || createSessionId()
    const providerSession = await this.restoreProviderSession({
      sessionId: restoredSessionId,
      systemPrompt: this.systemPrompt,
    }, stored.providerState)
    this.agent.setProviderSession(providerSession)

    // Provider is the source of truth for display messages
    this.agent.replaceMessages(providerSession.getDisplayMessages())

    this._sessionFile = sessionFileName
    this.updateSessionId(restoredSessionId)

    this.emit({
      type: 'session_loaded',
      sessionId: this._sessionId,
      sessionFile: sessionFileName
    })

    return true
  }

  async abort(): Promise<void> {
    this.agent.abort()
    await this.agent.waitForIdle()
  }

  clearMessages(): void {
    this.agent.clearMessages()
    void this.persistSession()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.agent.providerSession.dispose()
    this.listeners.clear()
    this.unsubscribeFromAgent()
  }

  private updateSessionId(newId: string): void {
    this._sessionId = newId
    this.agent.sessionId = newId
    this.sessionIdRef.current = newId
  }

  private emit(event: AgentWFYAgentEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error('[AgentWFYAgent] event listener failed', error)
      }
    })
  }

  private async persistSession(): Promise<void> {
    if (!this.persistSessionsToDisk || !this._sessionFile || this.disposed) {
      return
    }

    this.sessionWritePromise = this.sessionWritePromise
      .then(async () => {
        if (!this._sessionFile) {
          return
        }

        const providerState = this.agent.getProviderState()
        const title = this.agent.getProviderTitle()

        const stored: StoredSession = {
          version: SESSION_VERSION,
          sessionId: this._sessionId,
          providerId: this.providerId,
          title,
          providerState,
          updatedAt: Date.now(),
        }

        await writeSessionFile(this.sessionsDir, this._sessionFile, JSON.stringify(stored, null, 2))

        this.emit({
          type: 'session_saved',
          sessionId: this._sessionId,
          sessionFile: this._sessionFile
        })
      })
      .catch((error) => {
        console.error('[AgentWFYAgent] failed to persist session', error)
      })

    await this.sessionWritePromise
  }
}
