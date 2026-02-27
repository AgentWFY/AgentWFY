import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentState,
  type ThinkingLevel
} from '@mariozechner/pi-agent-core'
import {
  getModel,
  getModels,
  getProviders,
  supportsXhigh,
  type ImageContent,
  type Model
} from '@mariozechner/pi-ai'
import { createExecJsTool } from 'app/agent/exec_js'
import { requireClientTools, requireElectronTools, stringifyUnknown } from 'app/agent/tool_utils'

export const DEFAULT_PROVIDER = 'openrouter'
export const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2.5'
export const DEFAULT_SESSION_DIR = '.agentwfy/sessions'

const SESSION_VERSION = 1
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
const SESSION_SUMMARY_TAIL_MESSAGES = 20
const SESSION_SUMMARY_MAX_CHARS = 6000
const LEGACY_SYSTEM_DOC_PREFIX = 'system.'
const EXECJS_RUNTIME_API_DOCS = [
  '- runSql({ target?, path?, sql, params?, description?, confirmed? }) => Promise<any>',
  '- read({ path, offset?, limit? }) => Promise<string>',
  '- write({ path, content }) => Promise<string>',
  '- edit({ path, oldText, newText }) => Promise<string>',
  '- ls({ path?, limit? }) => Promise<string>',
  '- mkdir({ path, recursive? }) => Promise<void>',
  '- remove({ path, recursive? }) => Promise<void>',
  '- find({ pattern, path?, limit? }) => Promise<string>',
  '- grep({ pattern, path?, options? }) => Promise<string>',
  '- getTabs() => Promise<{ tabs: Array<{ id, title, viewId, viewUpdatedAt, viewChanged, pinned, selected }> }>',
  '- openTab({ viewId, title? }) => Promise<void>',
  '- closeTab({ tabId }) => Promise<void>',
  '- selectTab({ tabId }) => Promise<void>',
  '- reloadTab({ tabId }) => Promise<void>',
  '- captureTab({ tabId }) => Promise<{ captured: true; mimeType: "image/png" }> — the screenshot image is automatically attached to the tool result so you can see it',
  '- getTabConsoleLogs({ tabId, since?, limit? }) => Promise<Array<{ level: string; message: string; timestamp: number }>>',
  '- execTabJs({ tabId, code, timeoutMs? }) => Promise<any>',
].join('\n')

const CODE_SYSTEM_PROMPT = [
  '## [system.core]',
  'You are the AgentWFY desktop AI agent.',
  'You have one tool: execJs.',
  'When you need to read files, write files, query SQL, inspect app views, run JS in views, or capture screenshots, call execJs.',
  'Always prefer targeted, minimal operations and return concrete, actionable results.',
  '',
  '## [execjs.runtime]',
  'execJs runs JavaScript in a dedicated worker for the current session.',
  'Inside execJs code you can call these async host APIs:',
  EXECJS_RUNTIME_API_DOCS,
  '',
  'Rules:',
  '- Return JSON-serializable values from execJs.',
  '- Keep operations targeted and explicit.',
  '- File tools (read/write/edit/ls/mkdir/remove/find/grep) operate on paths in the working directory.',
  '- runSql accepts target="agent" or target="sqlite-file".',
  '- For target="sqlite-file", path must point to a SQLite file in the working directory.',
  '- Use runSql with confirmed=true only when a mutation is intentional and explicitly justified.',
  '',
  '## [tabs]',
  'The app uses a tab-based UI. Agent views are DB-backed UI views stored in the agent database table "views" (columns include id, name, content, updated_at).',
  'They are rendered as isolated webview runtimes via agentview://view/<viewId> when a view tab is opened.',
  '',
  'How to work with tabs:',
  '- Use getTabs() to see all open tabs and which one is selected.',
  '- Each tab has: id (tabId), title, viewId, viewUpdatedAt, viewChanged, pinned, selected.',
  '- Use captureTab({ tabId }), getTabConsoleLogs({ tabId }), and execTabJs({ tabId, code }) with tabId (not viewId) for diagnostics.',
  '- Use reloadTab({ tabId }) after updating a view\'s content via SQL to reload it in the browser.',
  '- Use openTab({ viewId, title? }) to open a new tab for a view. Use selectTab({ tabId }) to switch to an existing tab.',
  '- Use closeTab({ tabId }) to close a tab.',
  '- viewChanged indicates the view\'s DB content was updated but the tab has not been reloaded yet.',
  '- Discover views with runSql on target="agent" (for example: SELECT id, name, updated_at FROM views ORDER BY updated_at DESC).',
  '',
  'Inside an agent view runtime:',
  '- execTabJs executes in that tab\'s webview context (window/document are from the tab\'s view runtime).',
  '- In view code, call host APIs as window.electronAgentTools.<method>(...) (file methods use positional args; runSql and tab tools use object params).',
  '- Example: await window.electronAgentTools.runSql({ target: "agent", sql: "SELECT id, name FROM views LIMIT 5" }).',
  '- Example: await window.electronAgentTools.read("notes/todo.txt").',
].join('\n')

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

export interface HookMessage {
  customType?: string
  content: unknown
  display?: string
  details?: unknown
}

export interface ModelCycleResult {
  model: Model<any>
  thinkingLevel: ThinkingLevel
  isScoped: boolean
}

export interface CompactionResult {
  compacted: boolean
  beforeCount: number
  afterCount: number
  summary: string
}

export interface AgentWFYAgentInfo {
  provider: string
  modelId: string
  systemPromptChars: number
  tools: string[]
  sessionId: string
  sessionFile?: string
  sessionDir: string
  persistSessions: boolean
}

export interface AgentWFYAgentRunResult {
  assistantText: string
  messageCount: number
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
  parentSession?: string
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
    throw new Error(`Invalid session file name \"${sessionFile}\"`)
  }

  return fileName
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS_WITH_XHIGH.includes(value as ThinkingLevel)
}

function normalizeThinkingLevel(level: unknown, model?: Model<any>): ThinkingLevel {
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

function resolveModel(provider: string, modelId: string): Model<any> {
  const model = getModel(provider as any, modelId as any)
  if (model) {
    return model
  }

  const availableModels = getModels(provider as any)
  if (availableModels.length === 0) {
    const availableProviders = getProviders()
    throw new Error(
      `Unknown provider \"${provider}\". Configure one of ${availableProviders.join(', ')} or pass a valid provider supported by pi-ai.`
    )
  }

  const modelIds = availableModels.slice(0, 20).map((entry: any) => entry.id)
  throw new Error(
    `Model \"${modelId}\" was not found for provider \"${provider}\". Example available models: ${modelIds.join(', ')}`
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
  const codePrompt = CODE_SYSTEM_PROMPT.trim()

  try {
    const tools = requireElectronTools()
    if (typeof tools.runSql !== 'function') {
      throw new Error('window.electronAgentTools.runSql is not available in this renderer context')
    }

    await tools.runSql({
      target: 'agent',
      sql: 'DELETE FROM docs WHERE preload = 1 AND lower(name) LIKE ?',
      params: [`${LEGACY_SYSTEM_DOC_PREFIX}%`],
      description: 'Remove legacy system prompt docs now defined in code',
      confirmed: true,
    })

    const rows = await tools.runSql({
      target: 'agent',
      sql: 'SELECT name, content FROM docs WHERE preload = 1 ORDER BY name ASC',
      description: 'Load data-dir-specific preload docs for agent context'
    })
    const docs = parsePreloadDocRows(rows)
    const promptSection = buildDocsPromptSection(docs)

    if (!promptSection) {
      return codePrompt
    }

    return `${codePrompt}\n\n${promptSection}`
  } catch (error) {
    console.warn('[agent] failed to load data-dir prompt docs, using code prompt', error)
    return codePrompt
  }
}

function extractAssistantText(message: AgentMessage | undefined): string {
  if (!message || (message as any).role !== 'assistant') return ''

  const content = (message as any).content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''

  return content
    .filter((item: any) => item?.type === 'text')
    .map((item: any) => item.text)
    .join('')
}

function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i] as any).role === 'assistant') {
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

function toHookAgentMessage(message: HookMessage): AgentMessage {
  return {
    role: 'custom',
    customType: message.customType ?? 'hookMessage',
    content: message.content,
    display: message.display,
    details: message.details,
    timestamp: Date.now()
  } as any
}

function messageToSummaryLine(message: AgentMessage): string {
  const unknownMessage = message as any
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

function parseStoredSession(raw: string, sessionFile: string): StoredSession {
  let parsed: any

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse session file \"${sessionFile}\": ${message}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Session file \"${sessionFile}\" does not contain a JSON object`)
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : createSessionId(),
    parentSession: typeof parsed.parentSession === 'string' ? parsed.parentSession : undefined,
    model: parsed.model && typeof parsed.model === 'object' && typeof parsed.model.provider === 'string' && typeof parsed.model.id === 'string'
      ? {
        provider: parsed.model.provider,
        id: parsed.model.id
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
  private compactAbortController: AbortController | null = null
  private disposed = false

  private _sessionId: string
  private _sessionFile?: string
  private _parentSession?: string

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

  get model(): Model<any> | undefined {
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

  info(): AgentWFYAgentInfo {
    const model = this.model

    return {
      provider: model?.provider ?? this.infoData.provider,
      modelId: model?.id ?? this.infoData.modelId,
      systemPromptChars: this.infoData.systemPromptChars,
      tools: this.agent.state.tools.map((tool) => tool.name),
      sessionId: this._sessionId,
      sessionFile: this._sessionFile,
      sessionDir: this.sessionDirPath,
      persistSessions: this.persistSessionsToDisk
    }
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

  async run(prompt: string): Promise<AgentWFYAgentRunResult> {
    await this.prompt(prompt)

    return {
      assistantText: extractAssistantText(getLastAssistantMessage(this.messages)),
      messageCount: this.messages.length
    }
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

  onEvent(listener: AgentWFYAgentEventListener): () => void {
    return this.subscribe(listener)
  }

  async setModel(model: Model<any>): Promise<void> {
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

  async cycleModel(): Promise<ModelCycleResult | undefined> {
    const currentModel = this.model
    if (!currentModel) {
      return undefined
    }

    const models = getModels(currentModel.provider as any)
    if (models.length === 0) {
      return undefined
    }

    const currentIndex = models.findIndex(
      (model) => model.id === currentModel.id && model.provider === currentModel.provider
    )

    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + 1) % models.length

    const nextModel = models[nextIndex]
    await this.setModel(nextModel)

    return {
      model: nextModel,
      thinkingLevel: this.thinkingLevel,
      isScoped: false
    }
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    const model = this.model
    if (!model) {
      return undefined
    }

    const levels = supportsXhigh(model)
      ? THINKING_LEVELS_WITH_XHIGH
      : THINKING_LEVELS

    const currentIndex = levels.indexOf(this.thinkingLevel)
    const nextLevel = levels[(currentIndex + 1) % levels.length]
    this.setThinkingLevel(nextLevel)

    return this.thinkingLevel
  }

  async newSession(options?: { parentSession?: string }): Promise<boolean> {
    await this.abort()
    this.agent.reset()

    this._sessionId = createSessionId()
    this.agent.sessionId = this._sessionId
    this.sessionIdRef.current = this._sessionId
    this._parentSession = options?.parentSession

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
    this._parentSession = storedSession.parentSession
    this.agent.sessionId = this._sessionId
    this.sessionIdRef.current = this._sessionId

    this.emit({
      type: 'session_loaded',
      sessionId: this._sessionId,
      sessionFile: sessionFileName
    })

    return true
  }

  async sendHookMessage(message: HookMessage, triggerTurn = false): Promise<void> {
    const hookMessage = toHookAgentMessage(message)

    if (this.isStreaming) {
      this.agent.steer(hookMessage)
      return
    }

    if (triggerTurn) {
      await this.agent.prompt(hookMessage)
    } else {
      this.agent.appendMessage(hookMessage)
    }

    await this.persistSession()
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    if (this.compactAbortController) {
      throw new Error('Compaction is already running')
    }

    const beforeCount = this.messages.length
    if (beforeCount <= SESSION_SUMMARY_TAIL_MESSAGES) {
      return {
        compacted: false,
        beforeCount,
        afterCount: beforeCount,
        summary: ''
      }
    }

    const abortController = new AbortController()
    this.compactAbortController = abortController

    try {
      const summarySource = this.messages.slice(0, beforeCount - SESSION_SUMMARY_TAIL_MESSAGES)
      const keepMessages = this.messages.slice(beforeCount - SESSION_SUMMARY_TAIL_MESSAGES)
      const summary = buildCompactionSummary(summarySource, customInstructions)

      if (abortController.signal.aborted) {
        throw new Error('Compaction aborted')
      }

      const summaryMessage = toUserMessage(
        `Context summary generated by AgentWFYAgent compact():\n\n${summary}`
      )

      this.agent.replaceMessages([summaryMessage, ...keepMessages])
      await this.persistSession()

      return {
        compacted: true,
        beforeCount,
        afterCount: this.messages.length,
        summary
      }
    } finally {
      this.compactAbortController = null
    }
  }

  abortCompaction(): void {
    this.compactAbortController?.abort()
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

  history(): AgentMessage[] {
    return this.messages
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.listeners.clear()
    this.unsubscribeFromAgent()
  }

  destroy(): void {
    this.dispose()
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
      parentSession: this._parentSession,
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
