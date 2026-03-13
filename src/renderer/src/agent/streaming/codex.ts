/**
 * OpenAI Codex Responses API streaming.
 */
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
  StopReason,
  Usage,
  Model,
  AgentTool,
  Message,
} from '../types.js'
import { emitError, isRetryableStatus, type MessageStream, type StreamContext, type StreamOptions } from './types.js'
import { parseSSE } from './sse.js'
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
      // Convert to output items format
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
    emitError(stream, model, errorMessage, options.signal?.aborted ? 'aborted' : 'error', !options.signal?.aborted)
    return
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    emitError(stream, model, `Codex API error (${response.status}): ${text || response.statusText}`, 'error', isRetryableStatus(response.status))
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

  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  let stopReason: StopReason = 'end'

  // Track tool calls by item_id
  const toolCallBuilders = new Map<string, { contentIndex: number; args: string; id: string; name: string }>()

  try {
    for await (const sseEvent of parseSSE(response)) {
      if (sseEvent.data === '[DONE]') break

      let data: Record<string, unknown>
      try {
        data = JSON.parse(sseEvent.data)
      } catch {
        continue
      }

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
            partial: { ...partial, content: [...partial.content] },
          })
          break
        }

        // Function call start
        case 'response.function_call_arguments.start': {
          // Codex may not send explicit start events — handle in delta
          break
        }

        // Function call argument delta
        case 'response.function_call_arguments.delta': {
          const delta = data.delta as string | undefined
          const itemId = data.item_id as string | undefined
          if (!delta || !itemId) break

          let builder = toolCallBuilders.get(itemId)
          if (!builder) {
            // First delta for this tool call
            const contentIndex = partial.content.length
            partial.content.push({
              type: 'toolCall',
              id: itemId,
              name: '', // will be filled on done
              arguments: {},
            })
            builder = { contentIndex, args: '', id: itemId, name: '' }
            toolCallBuilders.set(itemId, builder)

            stream.push({
              type: 'toolcall_start',
              contentIndex,
              partial: { ...partial, content: [...partial.content] },
            })
          }

          builder.args += delta
          stream.push({
            type: 'toolcall_delta',
            contentIndex: builder.contentIndex,
            delta,
            partial: { ...partial, content: [...partial.content] },
          })
          break
        }

        // Function call done
        case 'response.function_call_arguments.done': {
          const itemId = data.item_id as string | undefined
          if (!itemId) break

          const builder = toolCallBuilders.get(itemId)
          if (builder) {
            const toolCall = partial.content[builder.contentIndex] as ToolCall
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
          break
        }

        // Output item added (gives us function name)
        case 'response.output_item.added': {
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            const itemId = item.id as string ?? item.call_id as string
            const name = item.name as string ?? ''
            const builder = toolCallBuilders.get(itemId)
            if (builder) {
              builder.name = name
              const toolCall = partial.content[builder.contentIndex] as ToolCall
              toolCall.name = name
            } else {
              // Pre-register
              const contentIndex = partial.content.length
              partial.content.push({
                type: 'toolCall',
                id: itemId,
                name,
                arguments: {},
              })
              toolCallBuilders.set(itemId, { contentIndex, args: '', id: itemId, name })
              stream.push({
                type: 'toolcall_start',
                contentIndex,
                partial: { ...partial, content: [...partial.content] },
              })
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
    if (options.signal?.aborted) {
      partial.stopReason = 'aborted'
      partial.errorMessage = 'Request aborted'
      partial.usage = usage
      stream.push({ type: 'done', partial: { ...partial, content: [...partial.content] } })
      return
    }
    emitError(stream, model, err instanceof Error ? err.message : String(err), 'error', true)
    return
  }

  if (toolCallBuilders.size > 0 && stopReason === 'end') {
    stopReason = 'toolCall'
  }

  partial.stopReason = stopReason
  partial.usage = usage
  stream.push({ type: 'done', partial: { ...partial, content: [...partial.content] } })
}

