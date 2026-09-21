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

  /** Resume the unfinished last turn without sending a new message. */
  continueTurn(): Promise<void>
  /** Drop the last user message and the reply it produced. */
  deleteLastMessage(): Promise<void>
  /** Send the last user message again, unchanged. */
  resendLastMessage(): Promise<void>
  /** Rewrite the last user message and run it again. `addFiles` are added to
   *  the attachments the original carried, which are always kept. */
  replaceLastMessage(text: string, addFiles?: FileContent[]): Promise<void>

  subscribe(handler: () => void): ChatUnsubscribe
}

export type ChatApi = AgentChatController
