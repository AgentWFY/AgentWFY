import type { AgentSnapshot, FileContent } from './types.js'
import type { SessionListItem } from './session_manager.js'

export type { SessionListItem } from './session_manager.js'

export type ChatUnsubscribe = () => void

export interface ChatCreateSessionOpts {
  label?: string
  prompt?: string
  providerId?: string
  providerOptions?: Record<string, unknown>
  files?: FileContent[]
}

export interface ChatSendOpts {
  streamingBehavior?: 'followUp'
  files?: FileContent[]
}

/** Operations the desktop chat panel performs against an agent. */
export interface AgentChatController {
  /** Which sessionId the chat panel is currently displaying (null if none). */
  getDisplayedSessionId(): string | null
  /** Update the displayed session shown in the chat panel. */
  setDisplayedSessionId(sessionId: string | null): Promise<void>

  getSessionList(): Promise<SessionListItem[]>
  getSnapshot(): AgentSnapshot

  createSession(opts: ChatCreateSessionOpts): Promise<string | null>
  sendMessage(text: string, opts?: ChatSendOpts): Promise<void>
  abort(): Promise<void>
  closeSession(): Promise<void>
  loadSession(sessionId: string): Promise<void>
  switchTo(sessionId: string): Promise<void>
  unloadSession(sessionId: string): Promise<void>

  setNotifyOnFinish(value: boolean): Promise<void>
  skipRetryDelay(): Promise<void>
  /** Remove a queued (not-yet-started) follow-up message by index. */
  removeQueuedMessage(index: number): Promise<void>

  subscribe(handler: () => void): ChatUnsubscribe
}

export type ChatApi = AgentChatController
