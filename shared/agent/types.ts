// ── Content types ──

export interface TextContent {
  type: 'text'
  text: string
}

export interface FileContent {
  type: 'file'
  data: string
  mimeType: string
  /** Set when the bytes were moved out of band for display (see
   *  `desktop/chat/message-blobs.ts`); `data` is empty in that case. Never set
   *  on content headed for a provider. */
  url?: string
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

import type { Block, DisplayMessage } from './provider_types.js'

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

/** One edit to the streaming message's block list. Only the trailing text block
 *  grows, but tool results splice in behind it, so blocks are addressed by
 *  index and the general form is needed. */
export type StreamingBlockOp =
  | { op: 'append'; index: number; text: string }
  | { op: 'set'; index: number; block: Block }
  | { op: 'trim'; length: number }

/** Incremental replacement for re-sending the whole streaming message every
 *  frame — see `ChatStreamingPatch`. */
export interface StreamingDelta {
  /** The `streamSeq` the receiver must already hold for these ops to apply. */
  base: number
  /** The `streamSeq` it holds afterwards. */
  seq: number
  ops: StreamingBlockOp[]
}

/** What the desktop pushes on `agent:streaming`.
 *
 *  The streaming message grows for the length of a turn, so re-sending it at
 *  ~60fps costs O(n²) serialization per turn. This form carries either the
 *  whole message (`streamingMessage` + `streamSeq`) or an incremental
 *  `streamingDelta` against the last one the receiver acknowledged; neither is
 *  present when only the status/retry fields moved.
 *
 *  Recovery is by sequence number rather than by request: a receiver that
 *  doesn't hold `delta.base` drops the delta and waits for the next whole
 *  message, which the pump's 5s heartbeat guarantees. Remote and mobile
 *  consumers stay on plain `SessionLivePatch` and always get whole messages. */
export interface ChatStreamingPatch extends Omit<SessionLivePatch, 'streamingMessage'> {
  streamingMessage?: DisplayMessage | null
  streamingDelta?: StreamingDelta
  /** Accompanies `streamingMessage`; the sequence the receiver now holds. */
  streamSeq?: number
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
  /** Bumped by the IPC pump whenever `messages` becomes a different transcript.
   *  Structured-clone hands the renderer a fresh array on every push, so
   *  reference identity can't tell "same transcript" from "new transcript" —
   *  this can. Absent on snapshots that didn't come through the pump. */
  messagesVersion?: number
  /** Sequence stamp for `streamingMessage`, so incremental
   *  {@link StreamingDelta}s that follow can be matched against it. Absent on
   *  snapshots that didn't come through the pump. */
  streamSeq?: number
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
