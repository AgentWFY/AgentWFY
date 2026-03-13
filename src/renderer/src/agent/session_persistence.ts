import type { AgentMessage, ThinkingLevel } from './types.js'
import { requireIpc } from './tool_utils.js'

export const SESSION_VERSION = 1

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

export interface StoredSession {
  version: number
  sessionId: string
  model?: {
    provider: string
    id: string
  }
  thinkingLevel: ThinkingLevel
  messages: AgentMessage[]
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

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel)
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

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : createSessionId(),
    model: parsed.model && typeof parsed.model === 'object' && typeof (parsed.model as Record<string, unknown>).provider === 'string' && typeof (parsed.model as Record<string, unknown>).id === 'string'
      ? {
        provider: (parsed.model as Record<string, unknown>).provider as string,
        id: (parsed.model as Record<string, unknown>).id as string
      }
      : undefined,
    thinkingLevel: isThinkingLevel(parsed.thinkingLevel) ? parsed.thinkingLevel : 'off',
    messages,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
  }
}
