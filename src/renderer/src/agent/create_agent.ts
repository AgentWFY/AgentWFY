/* eslint-disable import/no-unresolved */
import { Agent } from 'app/agent'
import type { AgentEvent, AgentMessage, AgentState, ThinkingLevel } from 'app/agent/types'
import {
  completeSimple,
  getModel,
  getModels,
  getProviders,
  isContextOverflow,
  supportsXhigh,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model
} from '@mariozechner/pi-ai'
import { createExecJsTool } from 'app/agent/exec_js'
import { requireClientTools, requireElectronTools, stringifyUnknown } from 'app/agent/tool_utils'

export const DEFAULT_PROVIDER = 'openrouter'
export const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2.5'
export const DEFAULT_SESSION_DIR = '.agentwfy/sessions'

const SESSION_VERSION = 1
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const SESSION_SUMMARY_TAIL_MESSAGES = 20
const SESSION_SUMMARY_MAX_CHARS = 6000
const AUTO_COMPACTION_MAX_RETRIES = 1
const AUTO_COMPACTION_INSTRUCTIONS =
  'Automatically compact context after overflow. Preserve user goals, constraints, unresolved tasks, tool outputs, file paths, and decisions.'
export const COMPACTION_SUMMARY_CUSTOM_TYPE = 'compactionSummary'
const COMPACTION_SUMMARY_CONTEXT_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`
const COMPACTION_SUMMARY_CONTEXT_SUFFIX = `
</summary>`
const COMPACTION_SUMMARY_SYSTEM_PROMPT =
  'You create concise, accurate context checkpoint summaries for coding sessions. Preserve exact file paths, function names, constraints, and unresolved tasks.'
const COMPACTION_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`
const COMPACTION_SUMMARY_MAX_TOKENS = 2200
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

interface StoredSession {
  version: number
  sessionId: string
  model?: {
    provider: string
    id: string
  }
  thinkingLevel: ThinkingLevel
  messages: AgentMessage[]
  updatedAt: number
}

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

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createSessionFileName(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}.json`
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

function normalizeSessionFileName(sessionFile: string): string {
  const normalizedPath = normalizeRelativePath(sessionFile)
  const fileName = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath

  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
    throw new Error(`Invalid session file name "${sessionFile}"`)
  }

  return fileName
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel)
}

function normalizeThinkingLevel(level: unknown, model?: Model<unknown>): ThinkingLevel {
  const fallback: ThinkingLevel = model?.reasoning ? 'minimal' : 'off'
  if (!isThinkingLevel(level)) {
    return fallback
  }

  if (!model?.reasoning) {
    return 'off'
  }

  if (level === 'xhigh' && !supportsXhigh(model)) {
    return 'high'
  }

  return level
}

function resolveModel(provider: string, modelId: string): Model<unknown> {
  const model = getModel(provider as never, modelId as never)
  if (model) {
    return model
  }

  const availableModels = getModels(provider as never)
  if (availableModels.length === 0) {
    const availableProviders = getProviders()
    throw new Error(
      `Unknown provider "${provider}". Configure one of ${availableProviders.join(', ')} or pass a valid provider supported by pi-ai.`
    )
  }

  const modelIds = availableModels.slice(0, 20).map((entry: { id?: string }) => entry.id)
  throw new Error(
    `Model "${modelId}" was not found for provider "${provider}". Example available models: ${modelIds.join(', ')}`
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

function requireSessionStorageTools() {
  const tools = requireClientTools()
  if (typeof tools.readSession !== 'function' || typeof tools.writeSession !== 'function') {
    throw new Error('Session storage methods are not available in electronClientTools')
  }

  return tools
}

async function loadSystemPrompt(): Promise<string> {
  try {
    const tools = requireElectronTools()
    if (typeof tools.runSql !== 'function') {
      throw new Error('window.agentwfy.runSql is not available in this renderer context')
    }

    const rows = await tools.runSql({
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

function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i] as unknown as { role: string }).role === 'assistant') {
      return messages[i]
    }
  }

  return undefined
}

function createTools(sessionIdRef: { current: string }) {
  return [
    createExecJsTool({
      getSessionId: () => sessionIdRef.current
    }),
  ]
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((item: Record<string, unknown>) => {
        if (item?.type === 'text' && typeof item.text === 'string') {
          return item.text
        }
        if (item?.type === 'image') {
          return '[image]'
        }
        return ''
      })
      .filter((line: string) => line.length > 0)
      .join('\n')
  }

  return stringifyUnknown(content)
}

function toUserMessage(text: string, images?: ImageContent[]): AgentMessage {
  const content: (ImageContent | { type: 'text'; text: string })[] = [{ type: 'text', text }]
  if (images && images.length > 0) {
    content.push(...images)
  }

  return {
    role: 'user',
    content,
    timestamp: Date.now()
  } as AgentMessage
}

function toCompactionSummaryMessage(summary: string, beforeCount: number): AgentMessage {
  return {
    role: 'custom',
    customType: COMPACTION_SUMMARY_CUSTOM_TYPE,
    content: summary,
    display: true,
    details: { beforeCount },
    timestamp: Date.now()
  } as unknown as AgentMessage
}

function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
  const llmMessages: Message[] = []

  for (const message of messages) {
    const unknownMessage = message as unknown as Record<string, unknown>
    const role = unknownMessage?.role

    if (role === 'user' || role === 'assistant' || role === 'toolResult') {
      llmMessages.push(message as unknown as Message)
      continue
    }

    if (role === 'custom' && unknownMessage?.customType === COMPACTION_SUMMARY_CUSTOM_TYPE) {
      const summary = extractTextContent(unknownMessage.content).trim()
      if (!summary) {
        continue
      }

      llmMessages.push({
        role: 'user',
        content: [{ type: 'text', text: `${COMPACTION_SUMMARY_CONTEXT_PREFIX}${summary}${COMPACTION_SUMMARY_CONTEXT_SUFFIX}` }],
        timestamp: typeof unknownMessage.timestamp === 'number' ? unknownMessage.timestamp : Date.now()
      } as Message)
    }
  }

  return llmMessages
}

function messageToSummaryLine(message: AgentMessage): string {
  const unknownMessage = message as unknown as Record<string, unknown>
  const role = typeof unknownMessage?.role === 'string' ? unknownMessage.role : 'unknown'
  const content = unknownMessage?.content

  if (typeof content === 'string') {
    return `[${role}] ${content}`
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (item?.type === 'text' && typeof item.text === 'string') {
          return item.text
        }
        if (item?.type === 'toolCall' && typeof item.name === 'string') {
          return `[tool:${item.name}]`
        }
        if (item?.type === 'thinking' && typeof item.thinking === 'string') {
          return `[thinking] ${item.thinking}`
        }
        if (item?.type === 'image') {
          return '[image]'
        }
        return ''
      })
      .filter((line) => line.length > 0)
      .join(' ')

    return `[${role}] ${text}`
  }

  return `[${role}] ${stringifyUnknown(content)}`
}

function buildCompactionSummary(messages: AgentMessage[], customInstructions?: string): string {
  const body = messages
    .map((message) => messageToSummaryLine(message))
    .join('\n')

  const instructionPrefix = customInstructions && customInstructions.trim()
    ? `Compaction instructions: ${customInstructions.trim()}\n\n`
    : ''

  const summary = `${instructionPrefix}${body}`
  if (summary.length <= SESSION_SUMMARY_MAX_CHARS) {
    return summary
  }

  return `${summary.slice(0, SESSION_SUMMARY_MAX_CHARS)}\n...<truncated ${summary.length - SESSION_SUMMARY_MAX_CHARS} chars>`
}

function extractTextFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((item: { type: string; text?: string }) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: { type: string; text?: string }) => item.text as string)
    .join('\n')
}

function parseStoredSession(raw: string, sessionFile: string): StoredSession {
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse session file "${sessionFile}": ${message}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Session file "${sessionFile}" does not contain a JSON object`)
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : createSessionId(),
    model: parsed.model && typeof parsed.model === 'object' && typeof (parsed.model as Record<string, unknown>).provider === 'string' && typeof (parsed.model as Record<string, unknown>).id === 'string'
      ? {
        provider: (parsed.model as Record<string, unknown>).provider as string,
        id: (parsed.model as Record<string, unknown>).id as string
      }
      : undefined,
    thinkingLevel: isThinkingLevel(parsed.thinkingLevel) ? parsed.thinkingLevel : 'off',
    messages,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
  }
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

  get model(): Model<unknown> | undefined {
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

  async setModel(model: Model<unknown>): Promise<void> {
    this.agent.setModel(model)

    if (!model.reasoning) {
      this.agent.setThinkingLevel('off')
    } else if (this.thinkingLevel === 'xhigh' && !supportsXhigh(model)) {
      this.agent.setThinkingLevel('high')
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
    const rawSession = await tools.readSession(sessionFileName)
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

    const contextWindow = this.getModelContextWindow()
    if (!isContextOverflow(lastAssistant, contextWindow)) {
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

    const contextWindow = this.getModelContextWindow()
    if (!isContextOverflow(lastMessage, contextWindow)) {
      return
    }

    this.agent.replaceMessages(messages.slice(0, -1))
  }

  private getModelContextWindow(): number | undefined {
    const model = this.model as { contextWindow?: unknown } | undefined
    if (typeof model?.contextWindow !== 'number' || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      return undefined
    }

    return model.contextWindow
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
      const summary = await this.generateCompactionSummary(summarySource, customInstructions)
      const summaryMessage = toCompactionSummaryMessage(summary, beforeCount)

      this.agent.replaceMessages([summaryMessage, ...keepMessages])
      await this.persistSession()

      return { compacted: true }
    } finally {
      this.isCompacting = false
    }
  }

  private async generateCompactionSummary(
    messages: AgentMessage[],
    customInstructions: string | undefined
  ): Promise<string> {
    const model = this.model
    if (!model) {
      return buildCompactionSummary(messages, customInstructions)
    }

    try {
      const provider = model.provider
      const apiKey = this.agent.getApiKey
        ? await this.agent.getApiKey(provider)
        : this.apiKey

      const conversationText = messages.map((message) => messageToSummaryLine(message)).join('\n')
      const additionalFocus = customInstructions?.trim()
        ? `\n\nAdditional focus: ${customInstructions.trim()}`
        : ''
      const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_SUMMARY_PROMPT}${additionalFocus}`

      const response = await completeSimple(
        model,
        {
          systemPrompt: COMPACTION_SUMMARY_SYSTEM_PROMPT,
          messages: [toUserMessage(promptText)]
        },
        {
          apiKey,
          maxTokens: Math.min(COMPACTION_SUMMARY_MAX_TOKENS, model.maxTokens || COMPACTION_SUMMARY_MAX_TOKENS),
          reasoning: model.reasoning ? 'high' : undefined
        }
      )

      if (response.stopReason === 'error') {
        throw new Error(response.errorMessage || 'Unknown summarization error')
      }

      const text = extractTextFromAssistant(response as AssistantMessage).trim()
      if (!text) {
        throw new Error('Summarization model returned empty text')
      }

      if (text.length <= SESSION_SUMMARY_MAX_CHARS) {
        return text
      }

      return `${text.slice(0, SESSION_SUMMARY_MAX_CHARS)}\n...<truncated ${text.length - SESSION_SUMMARY_MAX_CHARS} chars>`
    } catch (error) {
      console.warn('[AgentWFYAgent] model-based compaction summary failed; falling back to local summary', error)
      return buildCompactionSummary(messages, customInstructions)
    }
  }

  private buildStoredSession(): StoredSession {
    return {
      version: SESSION_VERSION,
      sessionId: this._sessionId,
      model: this.model
        ? {
          provider: this.model.provider,
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
        await tools.writeSession(this._sessionFile, payload)

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
