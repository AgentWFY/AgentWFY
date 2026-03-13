// ── Content types ──

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingContent {
  type: 'redacted_thinking'
  data: string
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

// ── Messages ──

export interface UserMessage {
  role: 'user'
  content: (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[]
  provider: string
  model: string
  usage: Usage
  stopReason: StopReason
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: unknown
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ── Model & Provider ──

export type ApiType = 'openai-completions' | 'anthropic-messages' | 'openai-codex-responses'
export type AuthType = 'api-key' | 'oauth-anthropic' | 'oauth-openai-codex'

export interface Provider {
  id: string
  name: string
  baseUrl: string
  api: ApiType
  auth: AuthType
}

export interface Model {
  id: string
  name: string
  reasoning: boolean
  provider: Provider
}

// ── Tool ──

export type JsonSchema = Record<string, unknown>

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[]
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

// ── Usage & StopReason ──

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

export type StopReason = 'end' | 'toolCall' | 'maxTokens' | 'error' | 'aborted'

// ── Thinking Level ──

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

// ── Custom Message ──

export interface CustomMessage {
  role: 'custom'
  customType?: string
  content: unknown
  display?: unknown
  details?: unknown
  timestamp: number
}

export type AgentMessage = Message | CustomMessage

// ── Agent State ──

export interface AgentState {
  systemPrompt: string
  model: Model
  thinkingLevel: ThinkingLevel
  tools: AgentTool[]
  messages: AgentMessage[]
  isStreaming: boolean
  streamMessage: AgentMessage | null
  pendingToolCalls: Set<string>
  error?: string
  retryInfo?: RetryInfo
}

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  error: string
}

// ── Agent Events ──

export type StreamEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: 'done'; partial: AssistantMessage }
  | { type: 'error'; error: string; partial: AssistantMessage; retryable?: boolean }

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'agent_idle' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; streamEvent: StreamEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | ({ type: 'retry'; delayMs: number } & RetryInfo)
