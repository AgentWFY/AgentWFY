/**
 * Built-in OpenAI-compatible provider.
 * Handles OpenRouter, DeepSeek, Groq, and any OpenAI-compatible API.
 * Runs in the main process with Node.js fetch().
 */
import type {
  ProviderFactory,
  ProviderSession,
  ProviderSessionConfig,
  ProviderInput,
  ProviderOutput,
  DisplayMessage,
  Block,
  TextContent,
  ImageContent,
} from '../agent/provider_types.js'
import { parseSSE } from '../agent/streaming/sse.js'

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
  private listeners = new Set<(event: ProviderOutput) => void>()
  private abortController: AbortController | null = null
  private config: ProviderSessionConfig
  private providerConfig: ProviderConfigSnapshot
  private lastInputTokens = 0

  constructor(
    config: ProviderSessionConfig,
    providerConfig: ProviderConfigSnapshot,
    initialMessages?: InternalMessage[],
    initialDisplayMessages?: DisplayMessage[],
  ) {
    this.config = config
    this.providerConfig = providerConfig
    if (initialMessages) {
      this.messages = [{ role: 'system', content: config.systemPrompt }, ...initialMessages]
    } else {
      this.messages.push({ role: 'system', content: config.systemPrompt })
    }
    if (initialDisplayMessages) {
      this.displayMessages = initialDisplayMessages.slice()
    }
  }

  send(event: ProviderInput): void {
    switch (event.type) {
      case 'user_message':
        this.handleUserMessage(event.text, event.images)
        break
      case 'exec_js_result':
        this.handleExecJsResult(event.id, event.content, event.isError)
        break
      case 'abort':
        this.abortController?.abort()
        break
    }
  }

  on(listener: (event: ProviderOutput) => void): void {
    this.listeners.add(listener)
    // Emit current status line immediately so the UI has it before any streaming
    listener({ type: 'status_line', text: this.buildStatusLine() })
  }

  off(listener: (event: ProviderOutput) => void): void {
    this.listeners.delete(listener)
  }

  getDisplayMessages(): DisplayMessage[] {
    return this.displayMessages.slice()
  }

  private buildStatusLine(): string {
    const parts: string[] = [this.providerConfig.modelId]
    if (this.providerConfig.reasoning) {
      parts.push(this.providerConfig.reasoning)
    }
    if (this.lastInputTokens > 0) {
      parts.push(formatTokens(this.lastInputTokens))
    }
    return parts.join(' · ')
  }

  private emitStatusLine(): void {
    this.emit({ type: 'status_line', text: this.buildStatusLine() })
  }

  private emitError(error: string, partialBlocks?: Block[]): void {
    const blocks: Block[] = partialBlocks ? [...partialBlocks] : []
    blocks.push({ type: 'error', text: error })
    this.displayMessages.push({ role: 'assistant', blocks, timestamp: Date.now() })
    this.emit({ type: 'error', error })
  }

  private emit(event: ProviderOutput): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private handleUserMessage(text: string, images?: ImageContent[]): void {
    // Build user content
    const content: unknown[] = [{ type: 'text', text }]
    if (images) {
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })
      }
    }
    this.messages.push({ role: 'user', content })

    // Add to display messages
    const blocks: Block[] = [{ type: 'text', text }]
    if (images) {
      for (const img of images) {
        blocks.push({ type: 'image', mimeType: img.mimeType, data: img.data })
      }
    }
    this.displayMessages.push({ role: 'user', blocks, timestamp: Date.now() })

    // Start streaming
    void this.stream()
  }

  private handleExecJsResult(id: string, content: (TextContent | ImageContent)[], isError: boolean): void {
    // Add tool result to internal messages
    const textParts = content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
    this.messages.push({
      role: 'tool',
      tool_call_id: id,
      content: textParts.join('\n'),
    })

    // Add exec_js_result block to last assistant display message
    const lastAssistant = this.displayMessages.length > 0
      ? this.displayMessages[this.displayMessages.length - 1]
      : null
    if (lastAssistant && lastAssistant.role === 'assistant') {
      lastAssistant.blocks.push({ type: 'exec_js_result', id, content, isError })
    }

    // Continue streaming
    void this.stream()
  }

  private async stream(): Promise<void> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const apiKey = this.providerConfig.apiKey ?? ''
    const baseUrl = this.providerConfig.baseUrl.replace(/\/v1\/?$/, '')
    const modelId = this.providerConfig.modelId
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

    this.emit({ type: 'start' })
    this.emitStatusLine()

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal.aborted) {
        this.emit({ type: 'done' })
        return
      }
      this.emitError(err instanceof Error ? err.message : String(err))
      return
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      this.emitError(`OpenAI API error (${response.status}): ${text || response.statusText}`)
      return
    }

    // Parse SSE stream
    let assistantText = ''
    let thinkingText = ''
    const toolCalls = new Map<number, ToolCallEntry>()
    const pendingTools: PendingToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0

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
          outputTokens = (u.completion_tokens as number) ?? 0
        }

        const choices = chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason?: string }> | undefined
        const choice = choices?.[0]
        if (!choice) continue

        const delta = choice.delta

        // Text content
        if (delta.content && typeof delta.content === 'string') {
          assistantText += delta.content
          this.emit({ type: 'text_delta', delta: delta.content })
        }

        // Reasoning content
        if (delta.reasoning_content && typeof delta.reasoning_content === 'string') {
          thinkingText += delta.reasoning_content
          this.emit({ type: 'thinking_delta', delta: delta.reasoning_content })
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
      if (signal.aborted) {
        this.emit({ type: 'done' })
        return
      }
      const partialBlocks: Block[] = []
      if (thinkingText) partialBlocks.push({ type: 'thinking', text: thinkingText })
      if (assistantText) partialBlocks.push({ type: 'text', text: assistantText })
      this.emitError(err instanceof Error ? err.message : String(err), partialBlocks)
      return
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
      })
    }

    // Build and push assistant internal message BEFORE emitting exec_js.
    // The core may execute tools and send exec_js_result back quickly,
    // which calls _stream() again — the assistant message must already be
    // in the history so the next API call includes it.
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

    // Create or append to display message
    this.displayMessages.push({ role: 'assistant', blocks, timestamp: Date.now() })

    // Update status line with context size
    if (inputTokens > 0) {
      this.lastInputTokens = inputTokens
      this.emitStatusLine()
    }

    // Emit exec_js after assistant message is committed
    for (const pt of pendingTools) {
      this.emit({ type: 'exec_js', id: pt.id, description: pt.description, code: pt.code })
    }

    // If there are pending tool calls, don't emit done — wait for tool results
    if (pendingTools.length > 0) {
      return
    }

    this.emit({ type: 'done' })
  }
}

// ── Provider config and factory ──

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'
export const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2.5'
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api'

const CONFIG_PREFIX = 'system.openai-compatible-provider'

export interface ConfigAccessors {
  getConfig(key: string, fallback?: unknown): unknown
  setConfig(key: string, value: unknown): void
}

export function createOpenAICompatibleFactory(
  configAccessors: ConfigAccessors,
): ProviderFactory {
  const { getConfig } = configAccessors

  function readProviderConfig(): { baseUrl: string; modelId: string; apiKey: string; reasoning: string | undefined } {
    return {
      baseUrl: (getConfig(`${CONFIG_PREFIX}.baseUrl`, DEFAULT_BASE_URL) as string),
      modelId: (getConfig(`${CONFIG_PREFIX}.modelId`, DEFAULT_MODEL_ID) as string),
      apiKey: (getConfig(`${CONFIG_PREFIX}.apiKey`, '') as string),
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

    restoreSession(messages: DisplayMessage[], config: ProviderSessionConfig): ProviderSession {
      const internalMessages: InternalMessage[] = []

      for (const msg of messages) {
        if (msg.role === 'user') {
          const textBlock = msg.blocks.find(b => b.type === 'text')
          const text = textBlock && textBlock.type === 'text' ? textBlock.text : ''
          const images = msg.blocks
            .filter((b): b is Block & { type: 'image' } => b.type === 'image')
            .map(b => ({ type: 'image_url' as const, image_url: { url: `data:${b.mimeType};base64,${b.data}` } }))
          const content: unknown[] = [{ type: 'text', text }]
          content.push(...images)
          internalMessages.push({ role: 'user', content })
        } else if (msg.role === 'assistant') {
          const assistantContent: string[] = []
          const toolCallsList: unknown[] = []
          const toolResults: InternalMessage[] = []

          for (const block of msg.blocks) {
            if (block.type === 'text') {
              assistantContent.push(block.text)
            } else if (block.type === 'exec_js') {
              toolCallsList.push({
                id: block.id,
                type: 'function',
                function: { name: 'execJs', arguments: JSON.stringify({ description: block.description, code: block.code }) },
              })
            } else if (block.type === 'exec_js_result') {
              const textParts = block.content
                .filter((c): c is TextContent => c.type === 'text')
                .map(c => c.text)
              toolResults.push({ role: 'tool', tool_call_id: block.id, content: textParts.join('\n') })
            }
          }

          if (assistantContent.length > 0 || toolCallsList.length > 0) {
            const assistantMsg: InternalMessage = { role: 'assistant' }
            if (assistantContent.length > 0) assistantMsg.content = assistantContent.join('\n')
            if (toolCallsList.length > 0) assistantMsg.tool_calls = toolCallsList
            internalMessages.push(assistantMsg)
          }
          internalMessages.push(...toolResults)
        }
      }

      return new OpenAICompatibleSession(config, readProviderConfig(), internalMessages, messages)
    },
  }
}
