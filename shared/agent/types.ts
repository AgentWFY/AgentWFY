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

export interface AgentTool<TDetails = unknown> {
  name: string
  label: string
  description: string
  parameters: JsonSchema
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
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

/** A follow-up message waiting in the queue while the agent is streaming. */
export interface QueuedMessage {
  text: string
  /** Number of file attachments carried with this queued message. */
  fileCount: number
}

/** Streaming-frequency fields shared by backend events and renderer IPC.
 *  `queuedMessages` is optional: the per-session backend stream and
 *  `sessions.get` always include it (it's how the queue reaches a remote
 *  desktop), but the desktop's high-frequency `agent:streaming` patch omits
 *  it — the queue changes rarely and rides on full snapshots instead. */
export interface SessionLivePatch {
  isStreaming: boolean
  streamingMessage: DisplayMessage | null
  statusLine: string | undefined
  retryState: RetryState | null
  stalledSince: number | null
  queuedMessages?: QueuedMessage[]
}

// Snapshot of the chat-UI-facing session manager state.
// Lives here (not in ipc/schema.ts) so portable runtime code can reference it.
export interface AgentSnapshot {
  messages: DisplayMessage[]
  isStreaming: boolean
  label: string
  streamingSessionsCount: number
  notifyOnFinish: boolean
  streamingMessage: DisplayMessage | null
  statusLine: string | undefined
  providerId: string
  activeSessionId: string | null
  streamingSessionIds: string[]
  retryState: RetryState | null
  stalledSince: number | null
  /** Follow-up messages queued behind the active turn (empty when none). */
  queuedMessages: QueuedMessage[]
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
  | { type: 'queue_changed' }
