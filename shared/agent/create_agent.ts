import { Agent } from './index.js'
import type { AgentEvent, AgentState, FileContent, RewindPoint } from './types.js'
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
import type { FileStore } from '../storage/file-store.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'

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
  store: FileStore
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
  private readonly store: FileStore
  private readonly persistSessionsToDisk: boolean
  readonly providerId: string
  /** Kept past construction so a rewind can rebuild the provider session from
   *  a snapshot — the same call a session reload makes. */
  private readonly restoreProviderSession: ProviderSessionRestorer
  private readonly systemPrompt: string

  private sessionWritePromise: Promise<void> = Promise.resolve()
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string

  private constructor(
    agent: Agent,
    store: FileStore,
    sessionFile: string | undefined,
    sessionId: string,
    persistSessions: boolean,
    providerId: string,
    restoreProviderSession: ProviderSessionRestorer,
    systemPrompt: string,
  ) {
    this.agent = agent
    this.store = store
    this.persistSessionsToDisk = persistSessions
    this._sessionFile = sessionFile
    this._sessionId = sessionId
    this.providerId = providerId
    this.restoreProviderSession = restoreProviderSession
    this.systemPrompt = systemPrompt

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
    const store = options.store
    const persistSessions = options.persistSessions ?? true

    if (persistSessions) {
      await ensureSessionsDir(store)
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
    let rewindPoint: RewindPoint | null = null
    let lastTurnInterrupted = false

    if (options.sessionFile) {
      const stored = options.storedSession
        ?? parseStoredSession(await readSessionFile(store, normalizeSessionFileName(options.sessionFile)), options.sessionFile)
      sessionId = stored.sessionId || freshSessionId
      sessionIdRef.current = sessionId

      providerSession = await options.restoreProviderSession({
        sessionId,
        systemPrompt,
      }, stored.providerState)

      // Provider is the source of truth for display messages
      initialMessages = providerSession.getDisplayMessages()
      rewindPoint = stored.rewind ?? null
      lastTurnInterrupted = stored.lastTurnInterrupted ?? false
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
      rewindPoint,
      lastTurnInterrupted,
    })

    const instance = new AgentWFYAgent(
      agent,
      store,
      sessionFile,
      sessionId,
      persistSessions,
      options.providerId,
      options.restoreProviderSession,
      systemPrompt,
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

  /** The last turn stopped short and can be picked up again. */
  get canContinue(): boolean {
    return this.agent.canContinue
  }

  /** The last user message can be edited, resent, or deleted. */
  get canRewind(): boolean {
    return this.agent.canRewind
  }

  /** Carry on from where the last turn stopped, sending no new message. */
  async continueTurn(): Promise<void> {
    await this.agent.continueTurn()
    await this.persistSession()
  }

  /** Drop the last user message and everything the agent said in reply. */
  async deleteLastMessage(): Promise<boolean> {
    const point = await this.rewind()
    if (!point) return false
    await this.persistSession()
    this.emit({ type: 'state_changed' })
    return true
  }

  /** Replace the last user message with `text` and run the turn again.
   *  Attachments that came with the original are kept; `addFiles` are added
   *  on top of them. */
  async replaceLastMessage(text: string, addFiles?: FileContent[]): Promise<void> {
    const point = await this.rewind()
    if (!point) {
      throw new Error('There is no message to edit.')
    }
    this.emit({ type: 'state_changed' })
    const files = [...(point.input.files ?? []), ...(addFiles ?? [])]
    await this.prompt(text, files.length > 0 ? { files } : {})
  }

  /** Send the last user message again, unchanged. */
  async resendLastMessage(): Promise<void> {
    const point = await this.rewind()
    if (!point) {
      throw new Error('There is no message to resend.')
    }
    this.emit({ type: 'state_changed' })
    const files = point.input.files
    await this.prompt(point.input.text, files && files.length > 0 ? { files } : {})
  }

  /** Roll the provider back to the state it had before the last user message,
   *  by rebuilding the session from the snapshot taken at the time. Returns
   *  the input that was rolled back, or null when there is no snapshot. */
  private async rewind(): Promise<RewindPoint | null> {
    if (this.isStreaming) {
      throw new Error('Stop the current response before changing the last message.')
    }
    const point = this.agent.rewindPoint
    if (!point) return null

    const restored = await this.restoreProviderSession(
      { sessionId: this._sessionId, systemPrompt: this.systemPrompt },
      point.providerState,
    )
    const previous = this.agent.providerSession
    this.agent.adoptRewoundSession(restored)
    previous.dispose()
    return point
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
        // The rewind snapshot is a second copy of the transcript, so it only
        // goes to disk for the case that outlives the app: a turn that was
        // stopped or failed, which the user may want to edit after reopening.
        //
        // Only a persist that runs once the turn has settled can see that
        // outcome — `lastTurnInterrupted` is set in the run loop's `finally`,
        // so mid-turn saves would report the *previous* turn's verdict and
        // attach a second copy of the history to every `state_changed`. On a
        // multi-megabyte session that is megabytes re-serialized and rewritten
        // per tool round, so those saves skip both fields.
        const settled = !this.isStreaming
        const interrupted = settled && this.agent.lastTurnInterrupted
        const rewind = interrupted ? this.agent.rewindPoint : null

        const stored: StoredSession = {
          version: SESSION_VERSION,
          sessionId: this._sessionId,
          providerId: this.providerId,
          title,
          providerState,
          updatedAt: Date.now(),
          ...(interrupted ? { lastTurnInterrupted: true } : {}),
          ...(rewind ? { rewind } : {}),
        }

        await writeSessionFile(this.store, this._sessionFile, JSON.stringify(stored, null, 2))

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
