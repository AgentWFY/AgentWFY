import type { AgentMessage, AssistantMessage, ImageContent, Message, Model } from './types.js'
import { stringifyUnknown } from './tool_utils.js'
import { createStream } from './streaming/types.js'

export const SESSION_SUMMARY_TAIL_MESSAGES = 20
export const SESSION_SUMMARY_MAX_CHARS = 6000
export const AUTO_COMPACTION_MAX_RETRIES = 1
export const AUTO_COMPACTION_INSTRUCTIONS =
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

export function toUserMessage(text: string, images?: ImageContent[]): AgentMessage {
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

export function extractTextContent(content: unknown): string {
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

export function toCompactionSummaryMessage(summary: string, beforeCount: number): AgentMessage {
  return {
    role: 'custom',
    customType: COMPACTION_SUMMARY_CUSTOM_TYPE,
    content: summary,
    display: true,
    details: { beforeCount },
    timestamp: Date.now()
  } as unknown as AgentMessage
}

export function convertAgentMessagesToLlm(messages: AgentMessage[]): Message[] {
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

export function messageToSummaryLine(message: AgentMessage): string {
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
        if (item?.type === 'redacted_thinking') {
          return '[redacted thinking]'
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

export function buildCompactionSummary(messages: AgentMessage[], customInstructions?: string): string {
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

export function extractTextFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((item) => item?.type === 'text' && typeof (item as { text?: string }).text === 'string')
    .map((item) => (item as { type: 'text'; text: string }).text)
    .join('\n')
}

export function isContextOverflow(message: AssistantMessage): boolean {
  if (message.stopReason === 'error' && message.errorMessage) {
    const msg = message.errorMessage.toLowerCase()
    return msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed') || msg.includes('maximum'))
  }
  if (message.stopReason === 'maxTokens') {
    return true
  }
  return false
}

export function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i] as unknown as { role: string }).role === 'assistant') {
      return messages[i]
    }
  }

  return undefined
}

export interface GenerateCompactionSummaryOptions {
  model: Model | undefined
  getApiKey?: (providerId: string) => Promise<string | undefined> | string | undefined
  fallbackApiKey?: string
  signal?: AbortSignal
}

export async function generateCompactionSummary(
  messages: AgentMessage[],
  customInstructions: string | undefined,
  options: GenerateCompactionSummaryOptions
): Promise<string> {
  const { model } = options
  if (!model) {
    return buildCompactionSummary(messages, customInstructions)
  }

  try {
    const apiKey = options.getApiKey
      ? await options.getApiKey(model.provider.id)
      : options.fallbackApiKey

    const conversationText = messages.map((message) => messageToSummaryLine(message)).join('\n')
    const additionalFocus = customInstructions?.trim()
      ? `\n\nAdditional focus: ${customInstructions.trim()}`
      : ''
    const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${COMPACTION_SUMMARY_PROMPT}${additionalFocus}`

    const summaryStream = createStream(
      model,
      {
        systemPrompt: COMPACTION_SUMMARY_SYSTEM_PROMPT,
        messages: [toUserMessage(promptText)] as Message[],
        tools: [],
      },
      {
        apiKey,
        maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
        reasoning: model.reasoning ? 'high' : undefined,
        signal: options.signal,
      }
    )

    const response = await summaryStream.result()

    if (response.stopReason === 'error') {
      throw new Error(response.errorMessage || 'Unknown summarization error')
    }

    const text = extractTextFromAssistant(response).trim()
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
