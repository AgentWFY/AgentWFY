import type { AgentMessage } from './types.js'
import type { DisplayMessage } from './provider_types.js'
import { requireIpc } from './tool_utils.js'

export const SESSION_VERSION = 1

export interface StoredSession {
  version: number
  sessionId: string
  messages: DisplayMessage[]
  updatedAt: number
}

export function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createSessionFileName(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}.json`
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

export function normalizeSessionFileName(sessionFile: string): string {
  const normalizedPath = normalizeRelativePath(sessionFile)
  const fileName = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath

  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
    throw new Error(`Invalid session file name "${sessionFile}"`)
  }

  return fileName
}

export function requireSessionStorageTools() {
  return requireIpc().sessions
}

export function parseStoredSession(raw: string, sessionFile: string): StoredSession {
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse session file "${sessionFile}": ${message}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Session file "${sessionFile}" does not contain a JSON object`)
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : createSessionId(),
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
  }
}

/**
 * Convert DisplayMessage[] to AgentMessage[] for rendering in the chat UI.
 */
export function displayMessagesToAgentMessages(displayMessages: DisplayMessage[]): AgentMessage[] {
  const result: AgentMessage[] = []

  for (const dm of displayMessages) {
    if (dm.role === 'user') {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
      for (const block of dm.blocks) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'image') content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      }
      result.push({ role: 'user', content, timestamp: dm.timestamp } as AgentMessage)
    } else if (dm.role === 'assistant') {
      const content: unknown[] = []
      for (const block of dm.blocks) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'thinking') content.push({ type: 'thinking', thinking: block.text })
        else if (block.type === 'exec_js') {
          content.push({
            type: 'toolCall',
            id: block.id,
            name: 'execJs',
            arguments: { code: block.code, description: 'Executing code' },
          })
        }
      }
      result.push({
        role: 'assistant',
        content,
        provider: '',
        model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'end',
        timestamp: dm.timestamp,
      } as unknown as AgentMessage)

      // Tool results after assistant message
      for (const block of dm.blocks) {
        if (block.type === 'exec_js_result') {
          result.push({
            role: 'toolResult',
            toolCallId: block.id,
            toolName: 'execJs',
            content: block.content,
            isError: block.isError,
            timestamp: dm.timestamp,
          } as unknown as AgentMessage)
        }
      }
    }
  }

  return result
}
