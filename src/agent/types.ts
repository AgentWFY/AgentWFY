// ── Content types ──

export interface TextContent {
  type: 'text'
  text: string
}

export interface FileContent {
  type: 'file'
  data: string
  mimeType: string
}

// ── Tool ──

export type JsonSchema = Record<string, unknown>

export interface AgentToolResult<T = unknown> {
  content: (TextContent | FileContent)[]
  details: T
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void

export interface AgentTool<TDetails = unknown> {
  name: string
  label: string
  description: string
  parameters: JsonSchema
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>
}

// ── Agent State (uses DisplayMessage from provider_types) ──

import type { DisplayMessage } from './provider_types.js'

export interface RetryState {
  attempt: number
  maxAttempts: number
  nextRetryAt: number
  lastError: string
  category: string
}

export interface AgentState {
  systemPrompt: string
  tools: AgentTool[]
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingMessage: DisplayMessage | null
  error?: string
  statusLine?: string
  retryState?: RetryState | null
  stalledSince?: number | null
}

// ── Agent Events ──

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'agent_idle' }
  | { type: 'stream_update' }
  | { type: 'status_line'; text: string }
  | { type: 'state_changed' }
  | { type: 'retry_scheduled'; attempt: number; maxAttempts: number; delayMs: number; error: string; category: string }
  | { type: 'retry_attempt'; attempt: number; maxAttempts: number }
  | { type: 'stalled'; elapsedMs: number }
