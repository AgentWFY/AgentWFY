import type { DisplayMessage, ProviderInfo } from '../../../agent/provider_types.js'
export type { DisplayMessage, ProviderInfo }
export type { RetryState } from '../../../agent/types.js'
import type { RetryState } from '../../../agent/types.js'

export interface OpenSession {
  file: string
  label: string
}

export type { SessionListItem } from '../../../agent/session_manager.js'

export interface AgentSnapshot {
  messages: DisplayMessage[]
  isStreaming: boolean
  label: string
  streamingSessionsCount: number
  notifyOnFinish: boolean
  streamingMessage: DisplayMessage | null
  statusLine: string | undefined
  providerId: string
  activeSessionFile: string | null
  streamingFiles: string[]
  retryState: RetryState | null
  stalledSince: number | null
}
