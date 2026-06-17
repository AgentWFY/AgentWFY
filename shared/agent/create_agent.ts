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
  runtimeRoot: string
  getJsRuntime: () => JsRuntime
}

export interface AgentWFYAgentPromptOptions {
  files?: FileContent[]
  streamingBehavior?: 'followUp'
  providerOptions?: Record<string, unknown>
}

export type AgentWFYAgentEvent = AgentEvent | {
  type: 'session_saved'
  sessionId: string
} | {
  type: 'session_loaded'
  sessionId: string
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

async function loadSystemPrompt(runtimeRoot: string): Promise<string> {
  try {
    const parsed = parseRunSqlRequest({
      target: 'agent',
      sql: "SELECT name, content FROM docs WHERE name NOT LIKE '%.%' ORDER BY name ASC",
      description: 'Load preload docs for agent system prompt',
    })
    const rows = await routeSqlRequest(runtimeRoot, parsed)
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
  readonly providerId: string

  private sessionWritePromise: Promise<void> = Promise.resolve()
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string

  private constructor(
    agent: Agent,
    sessionsDir: string,
    sessionFile: string | undefined,
    sessionId: string,
    persistSessions: boolean,
    providerId: string,
  ) {
    this.agent = agent
    this.sessionsDir = sessionsDir
    this.persistSessionsToDisk = persistSessions
    this._sessionFile = sessionFile
    this._sessionId = sessionId
    this.providerId = providerId

    this.agent.sessionId = this._sessionId

    this.unsubscribeFromAgent = this.agent.subscribe((event) => {
      this.emit(event)

      if (event.type === 'agent_end' || event.type === 'state_changed') {
        void this.persistSession()
      }
    })
  }

  static async create(options: AgentWFYAgentOptions): Promise<AgentWFYAgent> {
    const runtimeRoot = options.runtimeRoot
    const sessionsDir = `${runtimeRoot}/${DEFAULT_SESSION_DIR}`
    const persistSessions = options.persistSessions ?? true

    if (persistSessions) {
      await ensureSessionsDir(sessionsDir)
    }

    const freshSessionId = createSessionId()
    let sessionId = freshSessionId
    const sessionIdRef = { current: sessionId }
    const systemPrompt = await loadSystemPrompt(runtimeRoot)
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
      sessionId = stored.sessionId || freshSessionId
      sessionIdRef.current = sessionId

      providerSession = await options.restoreProviderSession({
        sessionId,
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
      sessionId,
      persistSessions,
      options.providerId,
    )

    if (options.sessionFile) {
      instance.emit({
        type: 'session_loaded',
        sessionId: instance._sessionId,
      })
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

  get queuedMessages() {
    return this.agent.queuedMessages
  }

  removeQueuedMessage(index: number): void {
    this.agent.removeFollowUp(index)
  }

  async prompt(text: string, options: AgentWFYAgentPromptOptions = {}): Promise<void> {
    const hasText = !!(text && text.trim())
    const hasFiles = !!(options.files && options.files.length > 0)
    if (!hasText && !hasFiles) {
      throw new Error('Prompt cannot be empty')
    }

    // Providers require a non-empty text block alongside file content,
    // so fall back to a single space when only files are provided.
    const promptText = hasText ? text : ' '

    if (this.isStreaming) {
      if (!options.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior: 'followUp' to queue the message.")
      }

      this.agent.followUp(promptText, options.files)
      return
    }

    await this.agent.prompt(promptText, { files: options.files, providerOptions: options.providerOptions })
    await this.persistSession()
  }

  subscribe(listener: AgentWFYAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
        })
      })
      .catch((error) => {
        console.error('[AgentWFYAgent] failed to persist session', error)
      })

    await this.sessionWritePromise
  }
}
