import type { AgentMessage, ImageContent } from './types.js'
import { stringifyUnknown } from './tool_utils.js'

export const COMPACTION_SUMMARY_CUSTOM_TYPE = 'compactionSummary'

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

export function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i] as unknown as { role: string }).role === 'assistant') {
      return messages[i]
    }
  }

  return undefined
}
