import { Agent } from './index.js'
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  ImageContent,
} from './types.js'
import { createExecJsTool } from './exec_js.js'
import { requireIpc } from './tool_utils.js'
import {
  SESSION_VERSION,
  type StoredSession,
  createSessionId,
  createSessionFileName,
  normalizeSessionFileName,
  requireSessionStorageTools,
  parseStoredSession,
} from './session_persistence.js'
import type { ProviderSession, ProviderSessionConfig } from './provider_types.js'
import {
  COMPACTION_SUMMARY_CUSTOM_TYPE,
  toUserMessage,
} from './session_compaction.js'

export { COMPACTION_SUMMARY_CUSTOM_TYPE } from './session_compaction.js'
export { toUserMessage } from './session_compaction.js'

export const DEFAULT_SESSION_DIR = '.agentwfy/sessions'

const FALLBACK_SYSTEM_PROMPT = 'You are the AgentWFY desktop AI agent. Your docs failed to load from the database — check the docs table in agent.db.'

export interface AgentWFYAgentOptions {
  createProviderSession: (config: ProviderSessionConfig) => ProviderSession | Promise<ProviderSession>
  sessionFile?: string
  persistSessions?: boolean
}

export interface AgentWFYAgentPromptOptions {
  images?: ImageContent[]
  streamingBehavior?: 'steer' | 'followUp'
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

async function loadSystemPrompt(): Promise<string> {
  try {
    const ipc = requireIpc()

    const rows = await ipc.sql.run({
      target: 'agent',
      sql: "SELECT name, content FROM docs WHERE name NOT LIKE '%.%' ORDER BY name ASC",
      description: 'Load preload docs for agent system prompt'
    })
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

function createTools(sessionIdRef: { current: string }) {
  return [
    createExecJsTool({
      getSessionId: () => sessionIdRef.current
    }),
  ]
}

export class AgentWFYAgent {
  readonly agent: Agent

  private readonly listeners = new Set<AgentWFYAgentEventListener>()
  private readonly unsubscribeFromAgent: () => void
  private readonly sessionDirPath: string
  private readonly persistSessionsToDisk: boolean
  private readonly sessionIdRef: { current: string }

  private sessionWritePromise: Promise<void> = Promise.resolve()
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string

  private constructor(
    agent: Agent,
    sessionDir: string,
    sessionFile: string | undefined,
    sessionId: string,
    sessionIdRef: { current: string },
    persistSessions: boolean,
  ) {
    this.agent = agent
    this.sessionDirPath = sessionDir
    this.persistSessionsToDisk = persistSessions
    this.sessionIdRef = sessionIdRef
    this._sessionFile = sessionFile
    this._sessionId = sessionId

    this.sessionIdRef.current = this._sessionId
    this.agent.sessionId = this._sessionId

    this.unsubscribeFromAgent = this.agent.subscribe((event) => {
      this.emit(event)

      if (event.type === 'message_end') {
        void this.persistSession()
      }
    })
  }

  static async create(options: AgentWFYAgentOptions): Promise<AgentWFYAgent> {
    const sessionDir = DEFAULT_SESSION_DIR
    const persistSessions = options.persistSessions ?? true

    const sessionId = createSessionId()
    const sessionIdRef = { current: sessionId }
    const systemPrompt = await loadSystemPrompt()
    const tools = createTools(sessionIdRef)
    const sessionFile = options.sessionFile
      ? normalizeSessionFileName(options.sessionFile)
      : (persistSessions ? createSessionFileName() : undefined)

    const providerSession = await options.createProviderSession({
      sessionId,
      systemPrompt,
    })

    const agent = new Agent({
      initialState: {
        systemPrompt,
        tools,
      },
      providerSession,
      sessionId,
    })

    const instance = new AgentWFYAgent(
      agent,
      sessionDir,
      sessionFile,
      sessionId,
      sessionIdRef,
      persistSessions,
    )

    if (options.sessionFile) {
      await instance.switchSession(sessionFile)
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

  get sessionDir(): string {
    return this.sessionDirPath
  }

  get persistSessions(): boolean {
    return this.persistSessionsToDisk
  }

  get messages(): AgentMessage[] {
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
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")
      }

      if (options.streamingBehavior === 'followUp') {
        await this.followUp(text)
      } else {
        await this.steer(text)
      }
      return
    }

    await this.agent.prompt(toUserMessage(text, options.images))
    await this.persistSession()
  }

  async steer(text: string): Promise<void> {
    if (!text || !text.trim()) {
      throw new Error('Steering message cannot be empty')
    }

    this.agent.steer(toUserMessage(text))
  }

  async followUp(text: string): Promise<void> {
    if (!text || !text.trim()) {
      throw new Error('Follow-up message cannot be empty')
    }

    this.agent.followUp(toUserMessage(text))
  }

  subscribe(listener: AgentWFYAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async newSession(): Promise<boolean> {
    await this.abort()
    this.agent.reset()

    this.updateSessionId(createSessionId())

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

    const sessionFileName = normalizeSessionFileName(sessionPath)
    const tools = requireSessionStorageTools()
    const rawSession = await tools.read(sessionFileName)
    const storedSession = parseStoredSession(rawSession, sessionFileName)

    this.agent.replaceMessages(storedSession.messages)

    this._sessionFile = sessionFileName
    this.updateSessionId(storedSession.sessionId || createSessionId())

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

  private buildStoredSession(): StoredSession {
    return {
      version: SESSION_VERSION,
      sessionId: this._sessionId,
      messages: this.messages,
      updatedAt: Date.now()
    }
  }

  private async persistSession(): Promise<void> {
    if (!this.persistSessionsToDisk || !this._sessionFile || this.disposed) {
      return
    }

    this.sessionWritePromise = this.sessionWritePromise
      .then(async () => {
        if (!this._sessionFile || this.disposed) {
          return
        }

        const tools = requireSessionStorageTools()
        const payload = JSON.stringify(this.buildStoredSession(), null, 2)
        await tools.write(this._sessionFile, payload)

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
