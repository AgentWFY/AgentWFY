/**
 * OpenAI Codex Responses API streaming.
 */
import type {
  TextContent,
  ToolCall,
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
import { decodeJwt } from '../oauth/utils.js'

function convertToInput(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n')
      if (text) {
        result.push({ role: 'user', content: text })
      }
    } else if (msg.role === 'assistant') {
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) {
          result.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: c.text }],
          })
        } else if (c.type === 'toolCall') {
          result.push({
            type: 'function_call',
            id: c.id,
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments),
          })
        }
      }
    } else if (msg.role === 'toolResult') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n')
      result.push({
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: text,
      })
    }
  }

  return result
}

function convertTools(tools: AgentTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

function mapReasoningEffort(level: string | undefined): string | undefined {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
      return 'high'
    default:
      return undefined
  }
}

function getAccountId(apiKey: string): string | undefined {
  const payload = decodeJwt(apiKey)
  const authClaims = payload?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  return authClaims?.chatgpt_account_id as string | undefined
}

export async function streamCodex(
  stream: MessageStream,
  model: Model,
  context: StreamContext,
  options: StreamOptions,
): Promise<void> {
  const url = `${model.provider.baseUrl}/v1/responses`
  const apiKey = options.apiKey ?? ''
  const accountId = getAccountId(apiKey)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  if (accountId) {
    headers['openai-organization'] = accountId
  }

  const body: Record<string, unknown> = {
    model: model.id,
    instructions: context.systemPrompt,
    input: convertToInput(context.messages),
    stream: true,
  }

  if (context.tools.length > 0) {
    body.tools = convertTools(context.tools)
  }

  if (options.reasoning && options.reasoning !== 'off' && model.reasoning) {
    const effort = mapReasoningEffort(options.reasoning)
    if (effort) {
      body.reasoning = { effort }
    }
  }

  if (options.maxTokens) {
    body.max_output_tokens = options.maxTokens
  }

  const response = await fetchStream(url, headers, body, stream, model, options, 'Codex')
  if (!response) return

  const partial = createPartial(model)
  const usage = partial.usage
  emitStart(stream, partial)

  let stopReason: StopReason = 'end'
  const toolCalls = new ToolCallAccumulator<string>()

  try {
    for await (const { data } of iterateSSE(response)) {
      const eventType = data.type as string

      switch (eventType) {
        // Text output
        case 'response.output_text.delta': {
          const delta = data.delta as string | undefined
          if (!delta) break

          let textIndex = partial.content.findIndex((c) => c.type === 'text')
          if (textIndex === -1) {
            partial.content.push({ type: 'text', text: '' })
            textIndex = partial.content.length - 1
          }
          const textContent = partial.content[textIndex] as TextContent
          textContent.text += delta
          stream.push({
            type: 'text_delta',
            contentIndex: textIndex,
            delta,
            partial: snapshot(partial),
          })
          break
        }

        // Function call start — Codex may not send explicit start events
        case 'response.function_call_arguments.start':
          break

        // Function call argument delta
        case 'response.function_call_arguments.delta': {
          const delta = data.delta as string | undefined
          const itemId = data.item_id as string | undefined
          if (!delta || !itemId) break

          let entry = toolCalls.get(itemId)
          if (!entry) {
            entry = toolCalls.start(itemId, itemId, '', partial, stream)
          }
          toolCalls.appendArgs(entry, delta, partial, stream)
          break
        }

        // Function call done
        case 'response.function_call_arguments.done': {
          const itemId = data.item_id as string | undefined
          if (!itemId) break

          const entry = toolCalls.get(itemId)
          if (entry) {
            toolCalls.finish(entry, partial, stream)
          }
          break
        }

        // Output item added (gives us function name)
        case 'response.output_item.added': {
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            const itemId = item.id as string ?? item.call_id as string
            const name = item.name as string ?? ''
            const entry = toolCalls.get(itemId)
            if (entry) {
              entry.name = name
              const toolCall = partial.content[entry.contentIndex] as ToolCall
              toolCall.name = name
            } else {
              toolCalls.start(itemId, itemId, name, partial, stream)
            }
          }
          break
        }

        // Response completed
        case 'response.completed': {
          const responseData = data.response as Record<string, unknown> | undefined
          if (responseData?.usage) {
            const u = responseData.usage as Record<string, number>
            usage.input = u.input_tokens ?? 0
            usage.output = u.output_tokens ?? 0
            usage.totalTokens = u.total_tokens ?? (usage.input + usage.output)
          }
          const status = responseData?.status as string | undefined
          if (status === 'incomplete') {
            stopReason = 'maxTokens'
          }
          break
        }

        case 'error': {
          const error = data.error as Record<string, unknown> | undefined
          const msg = (error?.message as string) ?? 'Unknown Codex API error'
          emitError(stream, model, msg)
          return
        }
      }
    }
  } catch (err) {
    handleStreamError(err, stream, model, partial, options)
    return
  }

  if (toolCalls.size > 0 && stopReason === 'end') {
    stopReason = 'toolCall'
  }

  emitDone(stream, partial, stopReason)
}
