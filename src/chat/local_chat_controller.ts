// LocalChatController — desktop chat controller backed by an in-process
// AgentSessionManager. The session manager already owns the "active session"
// concept, so this is a thin pass-through.

import type { AgentSessionManager } from '#shared/agent/session_manager.js'
import type {
  AgentChatController,
  ChatCreateSessionOpts,
  ChatSendOpts,
  ChatUnsubscribe,
  SessionListItem,
} from '#shared/agent/chat_controller.js'
import type { AgentSnapshot } from '#shared/agent/types.js'

export class LocalChatController implements AgentChatController {
  constructor(private readonly sessionManager: AgentSessionManager) {}

  getDisplayedSessionId(): string | null {
    return this.sessionManager.getSnapshot().activeSessionId
  }

  async setDisplayedSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      this.sessionManager.resetActive()
      return
    }
    this.sessionManager.switchTo(sessionId)
  }

  async getSessionList(): Promise<SessionListItem[]> {
    return this.sessionManager.getSessionList()
  }

  getSnapshot(): AgentSnapshot {
    return this.sessionManager.getSnapshot()
  }

  async createSession(opts: ChatCreateSessionOpts): Promise<string | null> {
    if (!opts.prompt) {
      this.sessionManager.resetActive()
      return null
    }
    return this.sessionManager.createSession({
      prompt: opts.prompt,
      label: opts.label,
      providerId: opts.providerId,
      files: opts.files,
    })
  }

  async sendMessage(text: string, opts?: ChatSendOpts): Promise<void> {
    await this.sessionManager.sendMessage(text, opts)
  }

  async abort(): Promise<void> {
    await this.sessionManager.abortActive()
  }

  async closeSession(): Promise<void> {
    await this.sessionManager.closeActiveSession()
  }

  async loadSession(file: string): Promise<void> {
    await this.sessionManager.openSessionInChat(file)
  }

  async switchTo(sessionId: string): Promise<void> {
    this.sessionManager.switchTo(sessionId)
  }

  async disposeSessionByFile(file: string): Promise<void> {
    await this.sessionManager.disposeSessionByFile(file)
  }

  async setNotifyOnFinish(value: boolean): Promise<void> {
    this.sessionManager.setNotifyOnFinish(value)
  }

  async skipRetryDelay(): Promise<void> {
    this.sessionManager.skipRetryDelay()
  }

  subscribe(handler: () => void): ChatUnsubscribe {
    return this.sessionManager.subscribe(handler)
  }
}
