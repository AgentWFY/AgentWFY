import { AgentWFYAgent } from 'app/agent/create_agent'
import type { AgentAuthConfig } from 'app/agent/agent_auth'
import { getEffectiveApiKey } from 'app/agent/agent_auth'
import { ensureSessionWorker, terminateSessionWorker } from 'app/agent/worker/session_worker_manager'
import type { ThinkingLevel } from '@mariozechner/pi-agent-core'

export interface SessionEntry {
  agent: AgentWFYAgent
  label: string
  unsubscribe: () => void
  wasStreaming?: boolean
  notifyOnFinish?: boolean
}

export interface SessionHistoryItem {
  file: string
  updatedAt: number
  firstUserMessage: string
}

export class AgentSessionManager {
  private sessions = new Map<string, SessionEntry>()
  private _activeSessionId: string | null = null
  private authConfig: AgentAuthConfig
  private listeners = new Set<() => void>()

  constructor(authConfig: AgentAuthConfig) {
    this.authConfig = authConfig
  }

  get activeSessionId(): string | null {
    return this._activeSessionId
  }

  get activeSession(): SessionEntry | null {
    if (!this._activeSessionId) return null
    return this.sessions.get(this._activeSessionId) ?? null
  }

  get allSessions(): Map<string, SessionEntry> {
    return this.sessions
  }

  get backgroundStreamingSessions(): [string, SessionEntry][] {
    const result: [string, SessionEntry][] = []
    for (const [id, entry] of this.sessions) {
      if (id !== this._activeSessionId && entry.agent.isStreaming) {
        result.push([id, entry])
      }
    }
    return result
  }

  async createSession(opts?: { label?: string; prompt?: string; background?: boolean; persistSessions?: boolean }): Promise<string> {
    const prevId = this._activeSessionId

    const config = this.authConfig
    const apiKey = await getEffectiveApiKey(config)

    const agent = await AgentWFYAgent.create({
      provider: config.provider,
      modelId: config.modelId,
      thinkingLevel: config.thinkingLevel as ThinkingLevel,
      ...(config.authMethod === 'api-key'
        ? { apiKey }
        : { getApiKey: () => getEffectiveApiKey(config) }
      ),
      ...(opts?.persistSessions === false ? { persistSessions: false } : {}),
    })

    const sessionId = agent.sessionId
    ensureSessionWorker(sessionId)
    const label = opts?.label || 'New session'

    const entry: SessionEntry = { agent, label, unsubscribe: () => {}, wasStreaming: false }
    entry.unsubscribe = agent.subscribe(() => {
      if (entry.label === 'New session') {
        const userLabel = extractFirstUserMessage(agent.messages, 60)
        if (userLabel) entry.label = userLabel
      }
      const wasStreaming = entry.wasStreaming
      entry.wasStreaming = agent.isStreaming
      if (wasStreaming && !agent.isStreaming) {
        this.handleStreamingFinished(sessionId, entry)
      }
      this.notify()
    })

    this.sessions.set(sessionId, entry)
    if (!opts?.background) {
      this._activeSessionId = sessionId
      if (prevId && prevId !== sessionId) {
        this.disposeIfIdle(prevId)
      }
    }
    this.notify()

    if (opts?.prompt) {
      agent.prompt(opts.prompt).catch((err) => {
        console.error('[AgentSessionManager] auto-prompt failed', err)
      })
    }

    return sessionId
  }

  switchTo(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    const prevId = this._activeSessionId
    this._activeSessionId = sessionId
    // Dispose previous active if not streaming
    if (prevId && prevId !== sessionId) {
      this.disposeIfIdle(prevId)
    }
    this.notify()
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return

    if (entry.agent.isStreaming) {
      await entry.agent.abort()
    }
    terminateSessionWorker(entry.agent.sessionId)
    entry.unsubscribe()
    entry.agent.dispose()
    this.sessions.delete(sessionId)

    if (this._activeSessionId === sessionId) {
      const remaining = Array.from(this.sessions.keys())
      this._activeSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }

    this.notify()
  }

  async loadSessionFromDisk(file: string): Promise<string> {
    const prevId = this._activeSessionId

    const config = this.authConfig
    const apiKey = await getEffectiveApiKey(config)

    const agent = await AgentWFYAgent.create({
      provider: config.provider,
      modelId: config.modelId,
      thinkingLevel: config.thinkingLevel as ThinkingLevel,
      sessionFile: file,
      ...(config.authMethod === 'api-key'
        ? { apiKey }
        : { getApiKey: () => getEffectiveApiKey(config) }
      ),
    })

    const sessionId = agent.sessionId
    ensureSessionWorker(sessionId)

    const label = extractFirstUserMessage(agent.messages, 60) ?? 'Session'

    const entry: SessionEntry = { agent, label, unsubscribe: () => {}, wasStreaming: false }
    entry.unsubscribe = agent.subscribe(() => {
      const wasStreaming = entry.wasStreaming
      entry.wasStreaming = agent.isStreaming
      if (wasStreaming && !agent.isStreaming) {
        this.handleStreamingFinished(sessionId, entry)
      }
      this.notify()
    })

    this.sessions.set(sessionId, entry)
    this._activeSessionId = sessionId
    if (prevId && prevId !== sessionId) {
      this.disposeIfIdle(prevId)
    }
    this.notify()

    return sessionId
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async spawnSession(prompt: string): Promise<{ agentId: string }> {
    const sessionId = await this.createSession({
      label: 'Spawned agent',
      prompt,
      background: true,
      persistSessions: false,
    })
    return { agentId: sessionId }
  }

  updateAuthConfig(config: AgentAuthConfig): void {
    this.authConfig = config
  }

  async disposeAll(): Promise<void> {
    for (const [, entry] of this.sessions) {
      if (entry.agent.isStreaming) {
        await entry.agent.abort()
      }
      terminateSessionWorker(entry.agent.sessionId)
      entry.unsubscribe()
      entry.agent.dispose()
    }

    this.sessions.clear()
    this._activeSessionId = null
    this.listeners.clear()
  }

  setNotifyOnFinish(sessionId: string, value: boolean): void {
    const entry = this.sessions.get(sessionId)
    if (entry) {
      entry.notifyOnFinish = value
      this.notify()
    }
  }

  private handleStreamingFinished(sessionId: string, entry: SessionEntry): void {
    if (entry.notifyOnFinish) {
      try {
        new Notification('Agent finished', { body: entry.label })
      } catch {
        // Notifications may not be supported
      }
    }

    if (sessionId !== this._activeSessionId) {
      this.disposeIfIdle(sessionId)
    }
  }

  private disposeIfIdle(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.agent.isStreaming) return
    terminateSessionWorker(entry.agent.sessionId)
    entry.unsubscribe()
    entry.agent.dispose()
    this.sessions.delete(sessionId)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[AgentSessionManager] listener error', err)
      }
    }
  }
}

let instance: AgentSessionManager | null = null

export function getSessionManager(): AgentSessionManager | null {
  return instance
}

export async function initSessionManager(config: AgentAuthConfig): Promise<AgentSessionManager> {
  if (instance) {
    await instance.disposeAll()
  }
  instance = new AgentSessionManager(config)
  return instance
}

function getTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const block of content) {
    const item = block as any
    if (item?.type === 'text' && typeof item.text === 'string') {
      text += item.text
    }
  }
  return text
}

export function extractFirstUserMessage(messages: unknown, maxLen: number): string | null {
  if (!Array.isArray(messages)) return null

  for (const msg of messages) {
    const m = msg as any
    if (m?.role !== 'user') continue
    const trimmed = getTextContent(m.content).trim()
    if (trimmed) return trimmed.slice(0, maxLen)
  }

  return null
}

export async function listSessionHistory(): Promise<SessionHistoryItem[]> {
  const tools = window.electronClientTools
  if (!tools || typeof tools.listSessions !== 'function' || typeof tools.readSession !== 'function') return []

  try {
    const sessions = await tools.listSessions(200)
    if (!Array.isArray(sessions) || sessions.length === 0) return []

    const items: SessionHistoryItem[] = []

    for (const session of sessions) {
      if (!session || typeof session.name !== 'string' || !session.name.endsWith('.json')) {
        continue
      }
      const file = session.name

      try {
        const raw = await tools.readSession(file)
        const parsed = JSON.parse(raw)
        const fallbackUpdatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : 0
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : fallbackUpdatedAt
        const firstUserMessage = extractFirstUserMessage(parsed.messages, 100) ?? ''

        if (firstUserMessage) {
          items.push({ file, updatedAt, firstUserMessage })
        }
      } catch {
        // Skip unparseable files
      }
    }

    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items.slice(0, 50)
  } catch {
    return []
  }
}
