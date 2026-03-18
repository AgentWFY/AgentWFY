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
  | { type: 'exec_js'; id: string; code: string }
  | { type: 'exec_js_result'; id: string; content: (TextContent | ImageContent)[]; isError: boolean }

// ── Provider session config ──

export interface ProviderSessionConfig {
  sessionId: string
  systemPrompt: string
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
  | { type: 'exec_js_start'; id: string }
  | { type: 'exec_js_delta'; id: string; delta: string }
  | { type: 'exec_js_end'; id: string }
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

// ── Provider info (returned by list query) ──

export interface ProviderInfo {
  id: string
  name: string
  settingsView?: string
}
