export type { TextContent, FileContent } from './types.js'
import type { TextContent, FileContent } from './types.js'

// ── Universal display format for sessions and UI ──

export interface DisplayMessage {
  role: 'user' | 'assistant'
  blocks: Block[]
  timestamp: number
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'file'; mimeType: string; data: string }
  | { type: 'attachment'; label: string; size: number; content: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'exec_js_result'; id: string; content: (TextContent | FileContent)[]; isError: boolean }
  | { type: 'error'; text: string }

// ── Provider session config ──

export interface ProviderSessionConfig {
  sessionId: string
  systemPrompt: string
  tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
}

// ── User input ──

export type UserInput = { text: string; files?: FileContent[] }

// ── Tool execution ──

export interface ToolCall {
  id: string
  description: string
  code: string
  timeoutMs?: number
}

export interface ToolResult {
  content: (TextContent | FileContent)[]
  isError: boolean
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolResult>

// ── Stream events (provider → core, yielded from async iterator) ──

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'status_line'; text: string }
  | { type: 'state_changed' }

// ── Error classification ──

export type ErrorCategory =
  | 'network'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'invalid_request'
  | 'content_policy'
  | 'context_overflow'

export class ProviderError extends Error {
  category: ErrorCategory
  retryAfterMs?: number

  constructor(message: string, category: ErrorCategory, retryAfterMs?: number) {
    super(message)
    this.name = 'ProviderError'
    this.category = category
    this.retryAfterMs = retryAfterMs
  }
}

// ── Provider session interface ──

export interface ProviderSession {
  stream(input: UserInput, executeTool: ToolExecutor): AsyncIterable<StreamEvent>
  retry(executeTool: ToolExecutor): AsyncIterable<StreamEvent>
  abort(): void
  getDisplayMessages(): DisplayMessage[]
  getState(): unknown
  getTitle?(): string
  dispose(): void
}

// ── Provider factory (what plugins register) ──

export interface ProviderFactory {
  id: string
  name: string
  settingsView?: string
  getStatusLine?(): string
  createSession(config: ProviderSessionConfig): ProviderSession
  restoreSession(config: ProviderSessionConfig, state: unknown): ProviderSession
}

// ── execJs tool definition — the only tool, shared by all providers ──

export const EXECJS_TOOL_DEFINITION = {
  name: 'execJs',
  description: 'Execute JavaScript in a dedicated session worker and return result + captured console output.\nRuntime API and agentview workflow details are defined in the system prompt sections [execjs.runtime] and [agentviews].',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short human-readable description of what this code does (shown to the user).',
      },
      code: {
        type: 'string',
        description: 'JavaScript code to execute. Use explicit return for result values.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: 120000,
        description: 'Execution timeout in milliseconds (default 5000).',
      },
    },
    required: ['description', 'code'],
    additionalProperties: false,
  },
} as const

// ── Provider info (returned by list query) ──

export interface ProviderInfo {
  id: string
  name: string
  settingsView?: string
}
