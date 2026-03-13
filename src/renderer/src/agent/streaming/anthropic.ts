/**
 * Anthropic Messages API streaming.
 */
import type {
  TextContent,
  ThinkingContent,
  StopReason,
  Model,
  AgentTool,
  Message,
} from '../types.js'
import { emitError, type MessageStream, type StreamContext, type StreamOptions } from './types.js'
import {
  createPartial, emitDone, emitStart,
  fetchStream, handleStreamError, iterateSSE, snapshot,
  ToolCallAccumulator,
} from './common.js'

function convertMessages(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = msg.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text }
        if (c.type === 'image') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: c.mimeType,
              data: c.data,
            },
          }
        }
        return { type: 'text', text: '' }
      })
      result.push({ role: 'user', content })
    } else if (msg.role === 'assistant') {
      const content: unknown[] = []
      for (const c of msg.content) {
        if (c.type === 'text') {
          content.push({ type: 'text', text: c.text })
        } else if (c.type === 'thinking') {
          content.push({ type: 'thinking', thinking: c.thinking, signature: c.signature ?? '' })
        } else if (c.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: c.data })
        } else if (c.type === 'toolCall') {
          content.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.arguments,
          })
        }
      }
      result.push({ role: 'assistant', content })
    } else if (msg.role === 'toolResult') {
      const content = msg.content.map((c) => {
        if (c.type === 'text') return { type: 'text', text: c.text }
        if (c.type === 'image') {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: c.mimeType,
              data: c.data,
            },
          }
        }
        return { type: 'text', text: '' }
      })
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content,
            is_error: msg.isError,
          },
        ],
      })
    }
  }

  return result
}

function convertTools(tools: AgentTool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end'
    case 'tool_use':
      return 'toolCall'
    case 'max_tokens':
      return 'maxTokens'
    default:
      return 'end'
  }
}

function getThinkingBudget(level: string | undefined): number | undefined {
  switch (level) {
    case 'minimal': return 1024
    case 'low': return 2048
    case 'medium': return 4096
    case 'high': return 8192
    case 'xhigh': return 16384
    default: return undefined
  }
}

export async function streamAnthropic(
  stream: MessageStream,
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): Promise<void> {
  const url = `${model.provider.baseUrl}/v1/messages`
  const apiKey = options.apiKey ?? ''
  const isOAuth = apiKey.includes('sk-ant-oat')

  const betaFeatures: string[] = []
  const thinking = options.reasoning && options.reasoning !== 'off' && model.reasoning
  if (thinking) {
    betaFeatures.push('interleaved-thinking-2025-05-14')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }

  if (isOAuth) {
    headers['Authorization'] = `Bearer ${apiKey}`
    betaFeatures.push('claude-code-20250219', 'oauth-2025-04-20')
  } else {
    headers['x-api-key'] = apiKey
  }

  if (betaFeatures.length > 0) {
    headers['anthropic-beta'] = betaFeatures.join(',')
  }

  let maxTokens = options.maxTokens ?? 16384

  const body: Record<string, unknown> = {
    model: model.id,
    system: context.systemPrompt,
    messages: convertMessages(context.messages),
    stream: true,
  }

  if (context.tools.length > 0) {
    body.tools = convertTools(context.tools)
  }

  if (thinking) {
    const budget = getThinkingBudget(options.reasoning) ?? 8192
    if (maxTokens <= budget) {
      maxTokens = budget + 4096
    }
    body.thinking = {
      type: 'enabled',
      budget_tokens: budget,
    }
  }

  body.max_tokens = maxTokens

  const response = await fetchStream(url, headers, body, stream, model, options, 'Anthropic')
  if (!response) return

  const partial = createPartial(model)
  const usage = partial.usage
  emitStart(stream, partial)

  let stopReason: StopReason = 'end'
  let currentBlockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | null = null
  let currentBlockIndex = -1
  const toolCalls = new ToolCallAccumulator<number>()

  try {
    for await (const { eventType: sseEventType, data } of iterateSSE(response)) {
      const eventType = sseEventType ?? (data.type as string)

      switch (eventType) {
        case 'message_start': {
          const message = data.message as Record<string, unknown> | undefined
          if (message?.usage) {
            const u = message.usage as Record<string, number>
            usage.input = u.input_tokens ?? 0
            usage.cacheRead = u.cache_read_input_tokens ?? 0
            usage.cacheWrite = u.cache_creation_input_tokens ?? 0
          }
          break
        }

        case 'content_block_start': {
          currentBlockIndex = (data.index as number) ?? partial.content.length
          const block = data.content_block as Record<string, unknown> | undefined
          currentBlockType = (block?.type as string) as typeof currentBlockType

          if (currentBlockType === 'text') {
            partial.content.push({ type: 'text', text: (block?.text as string) ?? '' })
          } else if (currentBlockType === 'thinking') {
            partial.content.push({ type: 'thinking', thinking: (block?.thinking as string) ?? '' })
          } else if (currentBlockType === 'redacted_thinking') {
            partial.content.push({ type: 'redacted_thinking', data: (block?.data as string) ?? '' })
          } else if (currentBlockType === 'tool_use') {
            toolCalls.start(
              currentBlockIndex,
              (block?.id as string) ?? '',
              (block?.name as string) ?? '',
              partial,
              stream,
            )
          }
          break
        }

        case 'content_block_delta': {
          const delta = data.delta as Record<string, unknown> | undefined
          if (!delta) break
          const deltaType = delta.type as string
          const contentIndex = (data.index as number) ?? currentBlockIndex

          if (deltaType === 'text_delta' && typeof delta.text === 'string') {
            const textContent = partial.content[contentIndex] as TextContent | undefined
            if (textContent) {
              textContent.text += delta.text
              stream.push({
                type: 'text_delta',
                contentIndex,
                delta: delta.text,
                partial: snapshot(partial),
              })
            }
          } else if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
            const thinkContent = partial.content[contentIndex] as ThinkingContent | undefined
            if (thinkContent) {
              thinkContent.thinking += delta.thinking
              stream.push({
                type: 'thinking_delta',
                contentIndex,
                delta: delta.thinking,
                partial: snapshot(partial),
              })
            }
          } else if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
            const thinkContent = partial.content[contentIndex] as ThinkingContent | undefined
            if (thinkContent) {
              thinkContent.signature = (thinkContent.signature ?? '') + delta.signature
            }
          } else if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const entry = toolCalls.get(contentIndex)
            if (entry) {
              toolCalls.appendArgs(entry, delta.partial_json, partial, stream)
            }
          }
          break
        }

        case 'content_block_stop': {
          const contentIndex = (data.index as number) ?? currentBlockIndex
          if (currentBlockType === 'tool_use') {
            const entry = toolCalls.get(contentIndex)
            if (entry) {
              toolCalls.finish(entry, partial, stream)
            }
          }
          currentBlockType = null
          break
        }

        case 'message_delta': {
          const delta = data.delta as Record<string, unknown> | undefined
          if (delta?.stop_reason) {
            stopReason = mapStopReason(delta.stop_reason as string)
          }
          const deltaUsage = data.usage as Record<string, number> | undefined
          if (deltaUsage) {
            usage.output = deltaUsage.output_tokens ?? usage.output
          }
          break
        }

        case 'message_stop':
          break

        case 'error': {
          const error = data.error as Record<string, unknown> | undefined
          const msg = (error?.message as string) ?? 'Unknown Anthropic API error'
          emitError(stream, model, msg)
          return
        }
      }
    }
  } catch (err) {
    handleStreamError(err, stream, model, partial, options)
    return
  }

  emitDone(stream, partial, stopReason)
}
