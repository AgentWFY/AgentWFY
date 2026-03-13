import { Agent } from './index.js'
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AssistantMessage,
  ImageContent,
  Model,
  ThinkingLevel,
} from './types.js'
import {
  getModel,
  getModels,
  getModelsConfigSync,
  getProviderIds,
  loadModelsConfig,
} from './models.js'
import { createExecJsTool } from './exec_js.js'
import { requireIpc } from './tool_utils.js'
import {
  SESSION_VERSION,
  type StoredSession,
  createSessionId,
  createSessionFileName,
  normalizeSessionFileName,
  isThinkingLevel,
  requireSessionStorageTools,
  parseStoredSession,
} from './session_persistence.js'
import {
  COMPACTION_SUMMARY_CUSTOM_TYPE,
  SESSION_SUMMARY_TAIL_MESSAGES,
  AUTO_COMPACTION_MAX_RETRIES,
  AUTO_COMPACTION_INSTRUCTIONS,
  toUserMessage,
  toCompactionSummaryMessage,
  convertAgentMessagesToLlm,
  isContextOverflow,
  getLastAssistantMessage,
  generateCompactionSummary,
} from './session_compaction.js'

export { COMPACTION_SUMMARY_CUSTOM_TYPE } from './session_compaction.js'
export { toUserMessage } from './session_compaction.js'

export const DEFAULT_PROVIDER = 'openrouter'
export const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2.5'
export const DEFAULT_SESSION_DIR = '.agentwfy/sessions'

const FALLBACK_SYSTEM_PROMPT = 'You are the AgentWFY desktop AI agent. Your docs failed to load from the database — check the docs table in agent.db.'

export interface AgentWFYAgentOptions {
  provider?: string
  modelId?: string
  apiKey?: string
  getApiKey?: () => Promise<string | undefined> | string | undefined
  thinkingLevel?: ThinkingLevel
  sessionDir?: string
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

interface AgentWFYAgentCreateArgs {
  agent: Agent
  provider: string
  modelId: string
  systemPromptChars: number
  apiKey?: string
  sessionDir: string
  sessionFile?: string
  sessionId: string
  sessionIdRef: { current: string }
  persistSessions: boolean
}

function normalizeThinkingLevel(level: unknown, model?: Model): ThinkingLevel {
  const fallback: ThinkingLevel = model?.reasoning ? 'minimal' : 'off'
  if (!isThinkingLevel(level)) {
    return fallback
  }

  if (!model?.reasoning) {
    return 'off'
  }

  return level
}

function resolveModel(provider: string, modelId: string): Model {
  const config = getModelsConfigSync()
  const model = getModel(config, provider, modelId)
  if (model) {
    return model
  }

  const availableModels = getModels(config, provider)
  if (availableModels.length === 0) {
    const availableProviders = getProviderIds(config)
    throw new Error(
      `Unknown provider "${provider}". Configure one of ${availableProviders.join(', ')} or add a provider to .agentwfy/models.json.`
    )
  }

  const modelIds = availableModels.slice(0, 20).map((entry) => entry.id)
  throw new Error(
    `Model "${modelId}" was not found for provider "${provider}". Available models: ${modelIds.join(', ')}`
  )
}

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
      sql: 'SELECT name, content FROM docs WHERE preload = 1 ORDER BY name ASC',
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

  private readonly infoData: {
    provider: string
    modelId: string
    systemPromptChars: number
  }

  private readonly listeners = new Set<AgentWFYAgentEventListener>()
  private readonly unsubscribeFromAgent: () => void
  private readonly sessionDirPath: string
  private readonly persistSessionsToDisk: boolean
  private readonly sessionIdRef: { current: string }

  private apiKey?: string
  private sessionWritePromise: Promise<void> = Promise.resolve()
  private isCompacting = false
  private compactionAbort?: AbortController
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string

  private constructor(args: AgentWFYAgentCreateArgs) {
    this.agent = args.agent
    this.infoData = {
      provider: args.provider,
      modelId: args.modelId,
      systemPromptChars: args.systemPromptChars
    }
    this.apiKey = args.apiKey
    this.sessionDirPath = args.sessionDir
    this.persistSessionsToDisk = args.persistSessions
    this.sessionIdRef = args.sessionIdRef
    this._sessionFile = args.sessionFile
    this._sessionId = args.sessionId

    this.sessionIdRef.current = this._sessionId
    this.agent.sessionId = this._sessionId

    if (this.apiKey) {
      this.agent.getApiKey = () => this.apiKey
    }

    this.unsubscribeFromAgent = this.agent.subscribe((event) => {
      this.emit(event)

      if (event.type === 'message_end') {
        void this.persistSession()
      }
    })
  }

  static async create(options: AgentWFYAgentOptions = {}): Promise<AgentWFYAgent> {
    await loadModelsConfig()

    const provider = options.provider ?? DEFAULT_PROVIDER
    const modelId = options.modelId ?? DEFAULT_MODEL_ID
    const sessionDir = DEFAULT_SESSION_DIR
    const persistSessions = options.persistSessions ?? true

    const sessionId = createSessionId()
    const sessionIdRef = { current: sessionId }
    const model = resolveModel(provider, modelId)
    const systemPrompt = await loadSystemPrompt()
    const tools = createTools(sessionIdRef)
    const sessionFile = options.sessionFile
      ? normalizeSessionFileName(options.sessionFile)
      : (persistSessions ? createSessionFileName() : undefined)

    const getApiKeyFn = options.getApiKey
      ? options.getApiKey
      : options.apiKey
        ? () => options.apiKey
        : undefined

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: normalizeThinkingLevel(options.thinkingLevel ?? 'off', model),
        tools
      },
      sessionId,
      convertToLlm: convertAgentMessagesToLlm,
      getApiKey: getApiKeyFn
    })

    const instance = new AgentWFYAgent({
      agent,
      provider,
      modelId,
      systemPromptChars: systemPrompt.length,
      apiKey: options.apiKey,
      sessionDir,
      sessionFile,
      sessionId,
      sessionIdRef,
      persistSessions
    })

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

  get model(): Model | undefined {
    return this.agent.state.model
  }

  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel
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

    await this.promptWithAutoCompaction(toUserMessage(text, options.images))
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

  async setModel(model: Model): Promise<void> {
    this.agent.setModel(model)

    if (!model.reasoning) {
      this.agent.setThinkingLevel('off')
    }

    await this.persistSession()
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.agent.setThinkingLevel(normalizeThinkingLevel(level, this.model))
    void this.persistSession()
  }

  async newSession(): Promise<boolean> {
    await this.abort()
    this.agent.reset()

    this._sessionId = createSessionId()
    this.agent.sessionId = this._sessionId
    this.sessionIdRef.current = this._sessionId

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

    if (storedSession.version !== SESSION_VERSION) {
      console.warn(
        `[AgentWFYAgent] Loading session version ${storedSession.version} (expected ${SESSION_VERSION}). Attempting best-effort restore.`
      )
    }

    if (storedSession.model) {
      try {
        const model = resolveModel(storedSession.model.provider, storedSession.model.id)
        this.agent.setModel(model)
      } catch (error) {
        console.warn(
          `[AgentWFYAgent] Failed to restore model ${storedSession.model.provider}/${storedSession.model.id}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    this.agent.setThinkingLevel(normalizeThinkingLevel(storedSession.thinkingLevel, this.model))
    this.agent.replaceMessages(storedSession.messages)

    this._sessionFile = sessionFileName
    this._sessionId = storedSession.sessionId || createSessionId()
    this.agent.sessionId = this._sessionId
    this.sessionIdRef.current = this._sessionId

    this.emit({
      type: 'session_loaded',
      sessionId: this._sessionId,
      sessionFile: sessionFileName
    })

    return true
  }

  async abort(): Promise<void> {
    this.compactionAbort?.abort()
    this.agent.abort()
    await this.agent.waitForIdle()
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
    this.agent.getApiKey = () => this.apiKey
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
    this.compactionAbort?.abort()
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

  private async promptWithAutoCompaction(message: AgentMessage): Promise<void> {
    let shouldContinue = false

    for (let retryCount = 0; retryCount <= AUTO_COMPACTION_MAX_RETRIES; retryCount += 1) {
      if (shouldContinue) {
        await this.agent.continue()
      } else {
        await this.agent.prompt(message)
      }

      const overflowMessage = this.getLastOverflowAssistantMessage()
      if (!overflowMessage) {
        return
      }

      if (retryCount >= AUTO_COMPACTION_MAX_RETRIES) {
        return
      }

      const compactResult = await this.compact(AUTO_COMPACTION_INSTRUCTIONS)
      if (!compactResult.compacted) {
        return
      }

      this.dropTrailingOverflowAssistant()
      shouldContinue = true
    }
  }

  private getLastOverflowAssistantMessage(): AssistantMessage | undefined {
    const lastAssistant = getLastAssistantMessage(this.messages) as AssistantMessage | undefined
    if (!lastAssistant) {
      return undefined
    }

    if (!isContextOverflow(lastAssistant)) {
      return undefined
    }

    return lastAssistant
  }

  private dropTrailingOverflowAssistant(): void {
    const messages = this.messages
    if (messages.length === 0) {
      return
    }

    const lastMessage = messages[messages.length - 1] as AssistantMessage
    if (lastMessage?.role !== 'assistant') {
      return
    }

    if (!isContextOverflow(lastMessage)) {
      return
    }

    this.agent.replaceMessages(messages.slice(0, -1))
  }

  private async compact(customInstructions?: string): Promise<{ compacted: boolean }> {
    if (this.isCompacting) {
      throw new Error('Compaction is already running')
    }

    const beforeCount = this.messages.length
    if (beforeCount <= SESSION_SUMMARY_TAIL_MESSAGES) {
      return { compacted: false }
    }

    this.isCompacting = true

    try {
      const summarySource = this.messages.slice(0, beforeCount - SESSION_SUMMARY_TAIL_MESSAGES)
      const keepMessages = this.messages.slice(beforeCount - SESSION_SUMMARY_TAIL_MESSAGES)

      this.compactionAbort = new AbortController()
      const summary = await generateCompactionSummary(summarySource, customInstructions, {
        model: this.model,
        getApiKey: this.agent.getApiKey
          ? (providerId: string) => this.agent.getApiKey!(providerId)
          : undefined,
        fallbackApiKey: this.apiKey,
        signal: this.compactionAbort.signal,
      })
      const summaryMessage = toCompactionSummaryMessage(summary, beforeCount)

      this.agent.replaceMessages([summaryMessage, ...keepMessages])
      await this.persistSession()

      return { compacted: true }
    } finally {
      this.isCompacting = false
    }
  }

  private buildStoredSession(): StoredSession {
    return {
      version: SESSION_VERSION,
      sessionId: this._sessionId,
      model: this.model
        ? {
          provider: this.model.provider.id,
          id: this.model.id
        }
        : undefined,
      thinkingLevel: this.thinkingLevel,
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
