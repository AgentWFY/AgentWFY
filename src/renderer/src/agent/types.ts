import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
} from '@mariozechner/pi-ai'
import type { Static, TSchema } from '@sinclair/typebox'

/** Thinking/reasoning level. Extends pi-ai's ThinkingLevel with "off". */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Custom message type for non-LLM messages (compaction summaries, hook messages, etc.) */
export interface CustomMessage {
  role: 'custom'
  customType?: string
  content: unknown
  display?: unknown
  details?: unknown
  timestamp: number
}

/** Union of LLM messages + custom messages. */
export type AgentMessage = Message | CustomMessage

export interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[]
  details: T
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  name: string
  label: string
  description: string
  parameters: TParameters
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>
}

export interface AgentState {
  systemPrompt: string
  model: Model<unknown>
  thinkingLevel: ThinkingLevel
  tools: AgentTool[]
  messages: AgentMessage[]
  isStreaming: boolean
  streamMessage: AgentMessage | null
  pendingToolCalls: Set<string>
  error?: string
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
