/**
 * OpenAI Chat Completions streaming.
 * Works with OpenRouter, DeepSeek, and any OpenAI-compatible API.
 */
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  StopReason,
  Usage,
  Model,
  AgentTool,
  Message,
} from '../types'
import { emitError, type MessageStream, type StreamContext, type StreamOptions } from './types'
import { parseSSE } from './sse'

interface OpenAIDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface OpenAIChoice {
  index: number
  delta: OpenAIDelta
  finish_reason?: string | null
}

interface OpenAIChunk {
  id?: string
  choices?: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function convertMessages(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = msg.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text }
        if (c.type === 'image') {
          return {
            type: 'image_url',
            image_url: { url: `data:${c.mimeType};base64,${c.data}` },
          }
        }
        return { type: 'text', text: '' }
      })
      result.push({ role: 'user', content })
    } else if (msg.role === 'assistant') {
      const content: unknown[] = []
      const toolCalls: unknown[] = []

      for (const c of msg.content) {
        if (c.type === 'text') {
          content.push({ type: 'text', text: c.text })
        } else if (c.type === 'toolCall') {
          toolCalls.push({
            id: c.id,
            type: 'function',
            function: {
              name: c.name,
              arguments: JSON.stringify(c.arguments),
            },
          })
        }
        // thinking content is not sent back to the API
      }

      const assistantMsg: Record<string, unknown> = { role: 'assistant' }
      if (content.length > 0) {
        // For single text content, use string format
        if (content.length === 1 && (content[0] as Record<string, unknown>).type === 'text') {
          assistantMsg.content = (content[0] as Record<string, unknown>).text
        } else {
          assistantMsg.content = content
        }
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    } else if (msg.role === 'toolResult') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join('\n'),
      })
    }
  }

  return result
}

function convertTools(tools: AgentTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end'
    case 'tool_calls':
      return 'toolCall'
    case 'length':
      return 'maxTokens'
    default:
      return 'end'
  }
}

export async function streamOpenAI(
  stream: MessageStream,
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): Promise<void> {
  const url = `${model.provider.baseUrl}/v1/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey ?? ''}`,
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: 'system', content: context.systemPrompt },
      ...convertMessages(context.messages),
    ],
    stream: true,
    stream_options: { include_usage: true },
  }

  if (context.tools.length > 0) {
    body.tools = convertTools(context.tools)
  }

  if (options.reasoning && options.reasoning !== 'off' && model.reasoning) {
    // OpenRouter/DeepSeek style reasoning budget
    body.reasoning = { effort: options.reasoning }
  }

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    const errorMessage = options.signal?.aborted
      ? 'Request aborted'
      : (err instanceof Error ? err.message : String(err))
    emitError(stream, model, errorMessage, options.signal?.aborted ? 'aborted' : 'error')
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    emitError(stream, model, `OpenAI API error (${response.status}): ${text || response.statusText}`)
    return
  }

  const partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    provider: model.provider.id,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'end',
    timestamp: Date.now(),
  }

  stream.push({ type: 'start', partial: { ...partial, content: [...partial.content] } })

  // Track in-progress tool calls by index
  const toolCallBuilders = new Map<number, { id: string; name: string; args: string; contentIndex: number }>()
  let stopReason: StopReason = 'end'
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }

  try {
    for await (const sseEvent of parseSSE(response)) {
      if (sseEvent.data === '[DONE]') break

      let chunk: OpenAIChunk
      try {
        chunk = JSON.parse(sseEvent.data)
      } catch {
        continue
      }

      // Usage from final chunk
      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? 0
        usage.output = chunk.usage.completion_tokens ?? 0
        usage.cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
        usage.totalTokens = chunk.usage.total_tokens ?? 0
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason)
      }

      const delta = choice.delta

      // Text content
      if (delta.content) {
        let textIndex = partial.content.findIndex((c) => c.type === 'text')
        if (textIndex === -1) {
          partial.content.push({ type: 'text', text: '' })
          textIndex = partial.content.length - 1
        }
        const textContent = partial.content[textIndex] as TextContent
        textContent.text += delta.content
        stream.push({
          type: 'text_delta',
          contentIndex: textIndex,
          delta: delta.content,
          partial: { ...partial, content: [...partial.content] },
        })
      }

      // Reasoning/thinking content
      if (delta.reasoning_content) {
        let thinkIndex = partial.content.findIndex((c) => c.type === 'thinking')
        if (thinkIndex === -1) {
          partial.content.push({ type: 'thinking', thinking: '' })
          thinkIndex = partial.content.length - 1
        }
        const thinkContent = partial.content[thinkIndex] as ThinkingContent
        thinkContent.thinking += delta.reasoning_content
        stream.push({
          type: 'thinking_delta',
          contentIndex: thinkIndex,
          delta: delta.reasoning_content,
          partial: { ...partial, content: [...partial.content] },
        })
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let builder = toolCallBuilders.get(tc.index)

          if (!builder) {
            // New tool call
            const contentIndex = partial.content.length
            const toolCall: ToolCall = {
              type: 'toolCall',
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: {},
            }
            partial.content.push(toolCall)
            builder = {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
              contentIndex,
            }
            toolCallBuilders.set(tc.index, builder)

            stream.push({
              type: 'toolcall_start',
              contentIndex,
              partial: { ...partial, content: [...partial.content] },
            })
          } else {
            // Delta for existing tool call
            if (tc.id) builder.id = tc.id
            if (tc.function?.name) builder.name += tc.function.name
            if (tc.function?.arguments) {
              builder.args += tc.function.arguments
              stream.push({
                type: 'toolcall_delta',
                contentIndex: builder.contentIndex,
                delta: tc.function.arguments,
                partial: { ...partial, content: [...partial.content] },
              })
            }
          }
        }
      }
    }
  } catch (err) {
    if (options.signal?.aborted) {
      partial.stopReason = 'aborted'
      partial.errorMessage = 'Request aborted'
      partial.usage = usage
      stream.push({ type: 'done', partial: { ...partial, content: [...partial.content] } })
      return
    }
    emitError(stream, model, err instanceof Error ? err.message : String(err))
    return
  }

  // Finalize tool calls — parse accumulated argument strings
  for (const builder of toolCallBuilders.values()) {
    const toolCall = partial.content[builder.contentIndex] as ToolCall
    toolCall.id = builder.id
    toolCall.name = builder.name
    try {
      toolCall.arguments = JSON.parse(builder.args)
    } catch {
      toolCall.arguments = {}
    }

    stream.push({
      type: 'toolcall_end',
      contentIndex: builder.contentIndex,
      toolCall: { ...toolCall },
      partial: { ...partial, content: [...partial.content] },
    })
  }

  if (toolCallBuilders.size > 0 && stopReason === 'end') {
    stopReason = 'toolCall'
  }

  partial.stopReason = stopReason
  partial.usage = usage
  stream.push({ type: 'done', partial: { ...partial, content: [...partial.content] } })
}

