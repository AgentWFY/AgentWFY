export type { TextContent, ImageContent } from './types.js'
import type { TextContent, ImageContent } from './types.js'

// ── Universal display format for sessions and UI ──

export interface DisplayMessage {
  role: 'user' | 'assistant'
  blocks: Block[]
  timestamp: number
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'attachment'; label: string; size: number; content: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'exec_js_result'; id: string; content: (TextContent | ImageContent)[]; isError: boolean }

// ── Provider session config ──

export interface ProviderSessionConfig {
  sessionId: string
  systemPrompt: string
  tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }>
}

// ── Events core sends to provider ──

export type ProviderInput =
  | { type: 'user_message'; text: string; images?: ImageContent[] }
  | { type: 'exec_js_result'; id: string; content: (TextContent | ImageContent)[]; isError: boolean }
  | { type: 'abort' }

// ── Events provider sends to core ──

export type ProviderOutput =
  | { type: 'start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'done' }
  | { type: 'error'; error: string; retryable?: boolean }
  | { type: 'status_line'; text: string }

// ── Provider session interface ──

export interface ProviderSession {
  send(event: ProviderInput): void
  on(listener: (event: ProviderOutput) => void): void
  off(listener: (event: ProviderOutput) => void): void
  getDisplayMessages(): DisplayMessage[] | Promise<DisplayMessage[]>
}

// ── Provider factory (what plugins register) ──

export interface ProviderFactory {
  id: string
  name: string
  settingsView?: string
  getStatusLine?(): string
  createSession(config: ProviderSessionConfig): ProviderSession
  restoreSession(messages: DisplayMessage[], config: ProviderSessionConfig): ProviderSession
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
