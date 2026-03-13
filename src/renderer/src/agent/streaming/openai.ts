/**
 * OpenAI Chat Completions streaming.
 * Works with OpenRouter, DeepSeek, and any OpenAI-compatible API.
 */
import type {
  TextContent,
  ThinkingContent,
  StopReason,
  Model,
  AgentTool,
  Message,
} from '../types.js'
import { type MessageStream, type StreamContext, type StreamOptions } from './types.js'
import {
  createPartial, createUsage, emitDone, emitStart,
  fetchStream, handleStreamError, iterateSSE, snapshot,
  ToolCallAccumulator,
} from './common.js'

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
    body.reasoning = { effort: options.reasoning }
  }

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens
  }

  const response = await fetchStream(url, headers, body, stream, model, options, 'OpenAI')
  if (!response) return

  const partial = createPartial(model)
  const usage = createUsage()
  emitStart(stream, partial)

  const toolCalls = new ToolCallAccumulator<number>()
  let stopReason: StopReason = 'end'

  try {
    for await (const data of iterateSSE(response)) {
      const chunk = data as Record<string, unknown>

      // Usage from final chunk
      if (chunk.usage) {
        const u = chunk.usage as Record<string, unknown>
        usage.input = (u.prompt_tokens as number) ?? 0
        usage.output = (u.completion_tokens as number) ?? 0
        const details = u.prompt_tokens_details as Record<string, number> | undefined
        usage.cacheRead = details?.cached_tokens ?? 0
        usage.totalTokens = (u.total_tokens as number) ?? 0
      }

      const choices = chunk.choices as OpenAIChoice[] | undefined
      const choice = choices?.[0]
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
          partial: snapshot(partial),
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
          partial: snapshot(partial),
        })
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = toolCalls.get(tc.index)

          if (!entry) {
            entry = toolCalls.start(
              tc.index,
              tc.id ?? '',
              tc.function?.name ?? '',
              partial,
              stream,
            )
            if (tc.function?.arguments) {
              entry.args = tc.function.arguments
            }
          } else {
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name += tc.function.name
            if (tc.function?.arguments) {
              toolCalls.appendArgs(entry, tc.function.arguments, partial, stream)
            }
          }
        }
      }
    }
  } catch (err) {
    handleStreamError(err, stream, model, partial, usage, options)
    return
  }

  // Finalize tool calls — parse accumulated argument strings
  toolCalls.finishAll(partial, stream)

  if (toolCalls.size > 0 && stopReason === 'end') {
    stopReason = 'toolCall'
  }

  emitDone(stream, partial, stopReason, usage)
}
