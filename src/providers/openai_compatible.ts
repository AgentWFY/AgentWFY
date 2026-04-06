/**
 * Built-in OpenAI-compatible provider.
 * Handles OpenRouter, DeepSeek, Groq, and any OpenAI-compatible API.
 * Runs in the main process with Node.js fetch().
 */
import type {
  ProviderFactory,
  ProviderSession,
  ProviderSessionConfig,
  DisplayMessage,
  Block,
  TextContent,
  FileContent,
  UserInput,
  ToolExecutor,
  StreamEvent,
} from '../agent/provider_types.js'
import { ProviderError } from '../agent/provider_types.js'
import { parseSSE } from '../agent/streaming/sse.js'

// ── Context compaction ──

const COMPACTION_SYSTEM_PROMPT = 'You are a conversation summarizer. Produce a concise, structured summary that another LLM will use to continue the work. Never refuse, never add commentary.'

const COMPACTION_PROMPT = `Summarize the conversation above into a structured context checkpoint. Use this format:

## Goal
[What the user is trying to accomplish]

## Progress
- [x] [Completed tasks]
- [ ] [In-progress tasks]

## Key Decisions
- [Important decisions and rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [File paths, function names, data, or references needed to continue]

Be concise. Preserve exact file paths, function names, and error messages.`

const COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages since the last summary. Update the existing summary provided in <previous-summary> tags.

RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from in-progress to completed when done
- UPDATE Next Steps based on what was accomplished
- If something is no longer relevant, remove it

Use the same format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Progress
- [x] [Include previously done items AND newly completed items]
- [ ] [Current work — update based on progress]

## Key Decisions
- [Preserve all previous, add new]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Be concise. Preserve exact file paths, function names, and error messages.`

function serializeMessages(messages: InternalMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'tool' ? 'Tool Result' : 'User'
    const content = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content)
        ? (msg.content as Array<{ type?: string; text?: string }>).filter(c => c.type === 'text' || c.text).map(c => c.text ?? '').join('\n')
        : String(msg.content ?? '')
    if (content) parts.push(`${role}: ${content.slice(0, 2000)}`)
  }
  return parts.join('\n\n')
}

// ── Context overflow detection ──

function isContextOverflow(responseText: string): boolean {
  try {
    const body = JSON.parse(responseText)
    const err = body?.error
    return err?.code === 'context_length_exceeded'
  } catch {
    return false
  }
}

// ── Retry ──

const MAX_RETRIES = 2
const INITIAL_DELAY_MS = 500

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 529 || status >= 500
}

function getRetryDelay(attempt: number, headers?: Headers): number {
  const retryAfter = headers?.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (!isNaN(seconds) && seconds > 0 && seconds <= 60) return seconds * 1000
  }
  const base = INITIAL_DELAY_MS * Math.pow(2, attempt)
  return base + Math.random() * base * 0.5
}

function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) { clearTimeout(timer); reject(new Error('aborted')); return }
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
}

// ── Internal message types (OpenAI format) ──

interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface ToolCallEntry {
  id: string
  name: string
  arguments: string
}

interface PendingToolCall {
  id: string
  name: string
  description: string
  code: string
  timeoutMs?: number
}

// ── OpenAI-compatible provider session ──

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(tokens)
}

interface ProviderConfigSnapshot {
  baseUrl: string
  modelId: string
  apiKey: string
  reasoning: string | undefined
}

class OpenAICompatibleSession implements ProviderSession {
  private messages: InternalMessage[] = []
  private displayMessages: DisplayMessage[] = []
  private abortController: AbortController | null = null
  private config: ProviderSessionConfig
  private providerConfig: ProviderConfigSnapshot
  private lastInputTokens = 0
  private _partialDisplayMessage: DisplayMessage | null = null
  private modelOverride: string | null = null

  constructor(
    config: ProviderSessionConfig,
    providerConfig: ProviderConfigSnapshot,
    initialMessages?: InternalMessage[],
    initialDisplayMessages?: DisplayMessage[],
    modelOverride?: string | null,
  ) {
    this.config = config
    this.providerConfig = providerConfig
    this.modelOverride = modelOverride ?? null
    if (initialMessages) {
      this.messages = [{ role: 'system', content: config.systemPrompt }, ...initialMessages]
      this.repairOrphanedToolCalls()
    } else {
      this.messages.push({ role: 'system', content: config.systemPrompt })
    }
    if (initialDisplayMessages) {
      this.displayMessages = initialDisplayMessages.slice()
    }
  }

  async *stream(input: UserInput, executeTool: ToolExecutor, providerOptions?: Record<string, unknown>): AsyncIterable<StreamEvent> {
    // Store model override on first call (from spawnSession providerOptions)
    if (typeof providerOptions?.model === 'string' && providerOptions.model) {
      this.modelOverride = providerOptions.model
    }
    this.addUserMessage(input.text, input.files)
    yield* this.doStream(executeTool)
  }

  async *retry(executeTool: ToolExecutor): AsyncIterable<StreamEvent> {
    this.discardPartialResponse()
    yield* this.doStream(executeTool)
  }

  abort(): void {
    this.abortController?.abort()
  }

  getDisplayMessages(): DisplayMessage[] {
    return this.displayMessages.slice()
  }

  getState(): unknown {
    // Exclude the system prompt (first message) — it's re-added on restore
    return {
      messages: this.messages.slice(1),
      displayMessages: this.displayMessages.slice(),
      ...(this.modelOverride ? { modelOverride: this.modelOverride } : {}),
    }
  }

  dispose(): void {
    this.abort()
  }

  // ── Private helpers ──

  private getEffectiveModelId(): string {
    return this.modelOverride ?? this.providerConfig.modelId
  }

  private buildStatusLine(): string {
    const parts: string[] = [this.getEffectiveModelId()]
    if (this.providerConfig.reasoning) {
      parts.push(this.providerConfig.reasoning)
    }
    if (this.lastInputTokens > 0) {
      parts.push(formatTokens(this.lastInputTokens))
    }
    return parts.join(' · ')
  }

  private addUserMessage(text: string, files?: FileContent[]): void {
    this.repairOrphanedToolCalls()
    // Build user content
    const content: unknown[] = [{ type: 'text', text }]
    if (files) {
      for (const f of files) {
        if (f.mimeType.startsWith('image/')) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${f.mimeType};base64,${f.data}` },
          })
        }
      }
    }
    this.messages.push({ role: 'user', content })

    // Add to display messages
    const blocks: Block[] = [{ type: 'text', text }]
    if (files) {
      for (const f of files) {
        blocks.push({ type: 'file', mimeType: f.mimeType, data: f.data })
      }
    }
    this.displayMessages.push({ role: 'user', blocks, timestamp: Date.now() })
  }

  private discardPartialResponse(): void {
    // Remove partial display message from failed attempt
    if (this._partialDisplayMessage) {
      const idx = this.displayMessages.indexOf(this._partialDisplayMessage)
      if (idx !== -1) this.displayMessages.splice(idx, 1)
      this._partialDisplayMessage = null
    }
    // Remove trailing assistant/tool messages that weren't committed
    while (this.messages.length > 1) {
      const last = this.messages[this.messages.length - 1]
      if (last.role === 'assistant' || last.role === 'tool') {
        this.messages.pop()
      } else {
        break
      }
    }
  }

  private addToolResult(id: string, content: (TextContent | FileContent)[], isError: boolean): void {
    const textParts = content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
    this.messages.push({
      role: 'tool',
      tool_call_id: id,
      content: textParts.join('\n'),
    })

    // Forward files as a follow-up user message (OpenAI tool role only supports text)
    const files = content.filter((c): c is FileContent => c.type === 'file')
    if (files.length > 0) {
      const fileBlocks: unknown[] = []
      for (const f of files) {
        if (f.mimeType.startsWith('image/')) {
          fileBlocks.push({
            type: 'image_url',
            image_url: { url: `data:${f.mimeType};base64,${f.data}` },
          })
        } else {
          fileBlocks.push({
            type: 'text',
            text: `[Attached file (${f.mimeType}) — not supported by this provider]`,
          })
        }
      }
      this.messages.push({ role: 'user', content: fileBlocks })
    }

    // Add exec_js_result block to last assistant display message
    const lastAssistant = this.displayMessages.length > 0
      ? this.displayMessages[this.displayMessages.length - 1]
      : null
    if (lastAssistant && lastAssistant.role === 'assistant') {
      lastAssistant.blocks.push({ type: 'exec_js_result', id, content, isError })
    }
  }

  private async *doStream(executeTool: ToolExecutor): AsyncGenerator<StreamEvent> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const apiKey = this.providerConfig.apiKey ?? ''
    const baseUrl = this.providerConfig.baseUrl.replace(/\/v1\/?$/, '')
    const modelId = this.getEffectiveModelId()
    const url = `${baseUrl}/v1/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages: this.messages,
      tools: this.config.tools.map(t => ({ type: 'function', function: t })),
      stream: true,
      stream_options: { include_usage: true },
    }

    if (this.providerConfig.reasoning) {
      body.reasoning = { effort: this.providerConfig.reasoning }
    }

    yield { type: 'status_line', text: this.buildStatusLine() }

    const bodyJson = JSON.stringify(body)
    let response: Response | undefined
    let lastError: string | undefined
    let lastStatus: number | undefined

    // Provider-level retry for transient HTTP errors
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        try {
          await retrySleep(getRetryDelay(attempt - 1, response?.headers), signal)
        } catch {
          return // aborted during retry sleep
        }
      }

      try {
        response = await fetch(url, { method: 'POST', headers, body: bodyJson, signal })
      } catch (err) {
        if (signal.aborted) return
        lastError = err instanceof Error ? err.message : String(err)
        continue
      }

      if (response.ok) {
        lastError = undefined
        break
      }

      lastStatus = response.status
      if (!isRetryableStatus(response.status)) {
        const text = await response.text().catch(() => '')

        // Context overflow — try compaction
        if (isContextOverflow(text)) {
          if (await this.compactMessages()) {
            yield { type: 'state_changed' }
            yield* this.doStream(executeTool)
            return
          }
          throw new ProviderError(
            `Context overflow: ${text || response.statusText}`,
            'context_overflow',
          )
        }

        // Auth errors
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError(
            `API key is missing or invalid. [Open Settings](agentview://view/${CONFIG_PREFIX}.settings-view) to add a valid API key.`,
            'auth',
          )
        }

        // Other non-retryable
        throw new ProviderError(
          `OpenAI API error (${response.status}): ${text || response.statusText}`,
          'invalid_request',
        )
      }

      lastError = `OpenAI API error (${response.status}): ${await response.text().catch(() => response!.statusText)}`
    }

    // Provider retry exhausted
    if (lastError || !response?.ok) {
      const category = lastStatus === 429 ? 'rate_limit' as const
        : lastStatus && lastStatus >= 500 ? 'server' as const
        : 'network' as const
      throw new ProviderError(lastError ?? 'Request failed', category)
    }

    // Parse SSE stream
    let assistantText = ''
    let thinkingText = ''
    const toolCalls = new Map<number, ToolCallEntry>()
    const pendingTools: PendingToolCall[] = []
    let inputTokens = 0

    try {
      for await (const sseEvent of parseSSE(response)) {
        if (sseEvent.data === '[DONE]') break

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(sseEvent.data)
        } catch {
          continue
        }

        // Usage
        if (chunk.usage) {
          const u = chunk.usage as Record<string, unknown>
          inputTokens = (u.prompt_tokens as number) ?? 0
        }

        const choices = chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason?: string }> | undefined
        const choice = choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        // Text content
        if (delta.content && typeof delta.content === 'string') {
          assistantText += delta.content
          yield { type: 'text_delta', delta: delta.content }
        }

        // Reasoning content
        if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
          thinkingText += delta.reasoning_content
          yield { type: 'thinking_delta', delta: delta.reasoning_content }
        }

        // Tool calls
        const tcDeltas = delta.tool_calls as Array<{
          index: number
          id?: string
          function?: { name?: string; arguments?: string }
        }> | undefined
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            let entry = toolCalls.get(tc.index)
            if (!entry) {
              entry = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
              toolCalls.set(tc.index, entry)
            } else {
              if (tc.id) entry.id = tc.id
              if (tc.function?.name) entry.name += tc.function.name
            }
            if (tc.function?.arguments) {
              entry.arguments += tc.function.arguments
            }
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return
      // SSE parse error or idle timeout — classify and throw
      const message = err instanceof Error ? err.message : String(err)
      throw new ProviderError(message, 'network')
    }

    // Finalize tool calls
    for (const entry of toolCalls.values()) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(entry.arguments)
      } catch {
        // empty
      }

      pendingTools.push({
        id: entry.id,
        name: entry.name,
        description: typeof args.description === 'string' ? args.description : 'Executing code',
        code: typeof args.code === 'string' ? args.code : '',
        ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
      })
    }

    // Build and push assistant internal message
    const assistantMsg: InternalMessage = { role: 'assistant' }
    if (assistantText) {
      assistantMsg.content = assistantText
    }
    if (toolCalls.size > 0) {
      assistantMsg.tool_calls = Array.from(toolCalls.values()).map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }))
    }
    this.messages.push(assistantMsg)

    // Build assistant display message
    const blocks: Block[] = []
    if (thinkingText) {
      blocks.push({ type: 'thinking', text: thinkingText })
    }
    if (assistantText) {
      blocks.push({ type: 'text', text: assistantText })
    }
    for (const pt of pendingTools) {
      blocks.push({ type: 'exec_js', id: pt.id, description: pt.description, code: pt.code })
    }
    const displayMsg: DisplayMessage = { role: 'assistant', blocks, timestamp: Date.now() }
    this.displayMessages.push(displayMsg)
    this._partialDisplayMessage = pendingTools.length > 0 ? displayMsg : null

    // Update status line with context size
    if (inputTokens > 0) {
      this.lastInputTokens = inputTokens
      yield { type: 'status_line', text: this.buildStatusLine() }
    }

    // Execute tools if any
    if (pendingTools.length > 0) {
      // Yield exec_js for all tools (so UI shows them)
      for (const pt of pendingTools) {
        yield { type: 'exec_js', id: pt.id, description: pt.description, code: pt.code }
      }

      // Execute tools in parallel
      const results = await Promise.all(
        pendingTools.map(pt => executeTool(pt)),
      )

      if (signal.aborted) {
        this.discardPartialResponse()
        return
      }

      // Process results
      for (let i = 0; i < pendingTools.length; i++) {
        this.addToolResult(pendingTools[i].id, results[i].content, results[i].isError)
      }
      this._partialDisplayMessage = null

      yield { type: 'state_changed' }

      // Continue streaming with tool results
      yield* this.doStream(executeTool)
      return
    }

    // No pending tools — done
    this._partialDisplayMessage = null
    yield { type: 'state_changed' }
  }

  private async compactMessages(): Promise<boolean> {
    // messages[0] is always the system prompt
    if (this.messages.length <= 7) return false

    const keepFromEnd = Math.max(6, Math.ceil((this.messages.length - 1) / 2))
    let splitIdx = this.messages.length - keepFromEnd
    if (splitIdx < 2) return false
    // Find a user message that starts a new turn
    while (splitIdx < this.messages.length) {
      const msg = this.messages[splitIdx]
      if (msg.role === 'user') break
      splitIdx++
    }
    // Don't split right after an assistant with tool_calls
    while (splitIdx > 1 && this.messages[splitIdx - 1]?.role === 'tool') {
      splitIdx--
    }
    if (splitIdx > 1 && this.messages[splitIdx - 1]?.role === 'assistant') {
      splitIdx--
    }
    if (splitIdx < 2 || splitIdx >= this.messages.length - 2) return false

    const oldMessages = this.messages.slice(1, splitIdx)
    const keptMessages = this.messages.slice(splitIdx)

    let previousSummary: string | undefined
    if (oldMessages.length > 0 && typeof oldMessages[0].content === 'string'
      && oldMessages[0].content.startsWith('[Context compacted')) {
      previousSummary = oldMessages[0].content
    }

    let summary: string
    try {
      const apiKey = this.providerConfig.apiKey ?? ''
      const baseUrl = this.providerConfig.baseUrl.replace(/\/v1\/?$/, '')
      const conversationText = serializeMessages(oldMessages)
      let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
      if (previousSummary) {
        promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
        promptText += COMPACTION_UPDATE_PROMPT
      } else {
        promptText += COMPACTION_PROMPT
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.providerConfig.modelId,
          messages: [
            { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
            { role: 'user', content: promptText },
          ],
          max_tokens: 4096,
        }),
      })

      if (!response.ok) {
        console.error('[openai-compatible] Compaction summarization failed:', response.status)
        return false
      }

      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      summary = result.choices?.[0]?.message?.content ?? ''
    } catch (err) {
      console.error('[openai-compatible] Compaction summarization error:', err)
      return false
    }

    if (!summary) return false

    const compactionText = `[Context compacted — ${oldMessages.length} earlier messages summarized]\n\n${summary}`
    this.messages = [
      this.messages[0], // system prompt
      { role: 'user', content: compactionText },
      { role: 'assistant', content: 'Understood, I have the context from the summary. Continuing.' },
      ...keptMessages,
    ]
    this.displayMessages.push({
      role: 'assistant',
      blocks: [{ type: 'text', text: compactionText }],
      timestamp: Date.now(),
    })
    return true
  }

  private repairOrphanedToolCalls(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
      if (msg.role !== 'assistant') continue
      const toolCalls = msg.tool_calls as Array<{ id: string }> | undefined
      if (!toolCalls || toolCalls.length === 0) return

      const resolved = new Set<string>()
      for (let j = i + 1; j < this.messages.length; j++) {
        if (this.messages[j].role === 'tool' && this.messages[j].tool_call_id) {
          resolved.add(this.messages[j].tool_call_id as string)
        }
      }

      for (const tc of toolCalls) {
        if (!resolved.has(tc.id)) {
          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'Tool execution was interrupted.',
          })
        }
      }
      return
    }
  }
}

// ── Provider config and factory ──

const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v3.2'
const DEFAULT_BASE_URL = 'https://openrouter.ai/api'

const CONFIG_PREFIX = 'system.openai-compatible-provider'

interface ConfigAccessors {
  getConfig(key: string, fallback?: unknown): unknown
  setConfig(key: string, value: unknown): void
}

export function createOpenAICompatibleFactory(
  configAccessors: ConfigAccessors,
): ProviderFactory {
  const { getConfig } = configAccessors

  function readProviderConfig(): { baseUrl: string; modelId: string; apiKey: string; reasoning: string | undefined } {
    return {
      baseUrl: (getConfig(`${CONFIG_PREFIX}.base-url`, DEFAULT_BASE_URL) as string),
      modelId: (getConfig(`${CONFIG_PREFIX}.model-id`, DEFAULT_MODEL_ID) as string),
      apiKey: (getConfig(`${CONFIG_PREFIX}.api-key`, '') as string),
      reasoning: getConfig(`${CONFIG_PREFIX}.reasoning`, undefined) as string | undefined,
    }
  }

  return {
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: 'OpenAI Compatible',
    settingsView: `${CONFIG_PREFIX}.settings-view`,

    getStatusLine(): string {
      const config = readProviderConfig()
      const parts: string[] = [config.modelId]
      if (config.reasoning) parts.push(config.reasoning)
      return parts.join(' · ')
    },

    createSession(config: ProviderSessionConfig): ProviderSession {
      return new OpenAICompatibleSession(config, readProviderConfig())
    },

    restoreSession(config: ProviderSessionConfig, state: unknown): ProviderSession {
      const stateObj = state as { messages?: InternalMessage[]; displayMessages?: DisplayMessage[]; modelOverride?: string } | null
      const apiMessages = stateObj?.messages && Array.isArray(stateObj.messages) ? stateObj.messages : []
      const displayMessages = stateObj?.displayMessages && Array.isArray(stateObj.displayMessages) ? stateObj.displayMessages : []
      const modelOverride = typeof stateObj?.modelOverride === 'string' ? stateObj.modelOverride : null
      return new OpenAICompatibleSession(config, readProviderConfig(), apiMessages, displayMessages, modelOverride)
    },
  }
}
