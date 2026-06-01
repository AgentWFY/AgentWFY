// Owns the live MobileBackend instance and its lifecycle. There is exactly
// one connection at a time; switching agents tears down the previous one.
//
// Internal state — active backend, active agent id + meta, latest status —
// is exposed through synchronous getters. Every mutation broadcasts a
// window CustomEvent (see events.ts) so any component can react without
// holding a shared store.
//
// connectGeneration protects against races where buffered events from a
// prior attempt arrive after a superseding connect/disconnect; callbacks
// captured by an old attempt no-op if their generation no longer matches.

import type {
  AgentBackendEvent,
  BackendStatusSnapshot,
  ProviderState,
  SessionState,
  SessionSummary,
} from '#shared/backend/interface.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'
import type { FileContent } from '#shared/agent/types.js'
import type { PageApi, PageInfo } from '#shared/page/types.js'
import type { AgentMeta } from '../agent-meta.js'
import { createMobileBackend, type MobileBackend } from '../backend.js'
import { MobilePageController } from '../page/mobile-page-host.js'
import { bridge } from '../tauri-bridge.js'
import { dispatch, listen } from '../events.js'
import { agentRegistry } from './agent-registry.js'

export const IDLE_STATUS: BackendStatusSnapshot = {
  state: 'disconnected',
  message: '',
  updatedAt: 0,
}

class BackendSession {
  private session: MobileBackend | null = null
  private activeAgentId: string | null = null
  private activeMeta: AgentMeta | null = null
  private status: BackendStatusSnapshot = { ...IDLE_STATUS }
  private providers: ProviderState | null = null
  private pageController: MobilePageController | null = null
  private pageUnsubscribe: (() => void) | null = null
  private connectGeneration = 0
  private readonly rememberedSessionIds = new Map<string, string>()

  install(): void {
    listen('switch-agent', ({ agentId }) => { void this.connect(agentId) })
    listen('remove-agent', ({ agentId }) => { void this.handleRemove(agentId) })
    listen('disconnect-agent', ({ agentId }) => { void this.handleDisconnect(agentId) })
    listen('abort-session', ({ sessionId }) => { void this.abortSession(sessionId) })
    listen('remove-session', ({ sessionId }) => { void this.removeSession(sessionId) })
  }

  // ── Synchronous getters (used by components that need to read once) ──────

  getActiveAgentId(): string | null { return this.activeAgentId }
  getActiveMeta(): AgentMeta | null { return this.activeMeta }
  getStatus(): BackendStatusSnapshot { return this.status }
  isConnected(): boolean { return this.status.state === 'connected' }
  /** Live backend. Null when disconnected. Do not cache across disconnects —
   *  RemoteBackend.stop() clears subscriber sets so any subscriptions
   *  attached via the returned object will be silently dropped. */
  getBackend(): MobileBackend['backend'] | null { return this.session?.backend ?? null }
  getProviders(): ProviderState | null { return this.providers }
  getPageTools(): PageApi | null { return this.pageController?.pageTools ?? null }
  getCurrentPage(): PageInfo | null { return this.pageController?.getCurrentPage() ?? null }

  renameCurrentViewPage(name: string): PageInfo | null {
    return this.pageController?.renameCurrentView(name) ?? null
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  async connect(agentId: string): Promise<void> {
    const meta = agentRegistry.getMeta(agentId)
    if (!meta) {
      dispatch('error', { message: `Unknown agent: ${agentId}` })
      return
    }
    const remoteConfig = meta.remoteConfig
    const gen = ++this.connectGeneration

    const preferredSessionId = this.rememberedSessionIds.get(agentId) ?? null

    // Snap agent-scoped runtime pointers synchronously BEFORE dispatching
    // agent-switched. Any listener that reacts to the switch by calling
    // back into this service must not see the previous agent's backend or
    // page surface under the already-bumped generation.
    const oldSession = this.session
    const oldPageController = this.pageController
    this.pageUnsubscribe?.()
    this.pageUnsubscribe = null
    this.session = null
    this.pageController = null

    this.activeAgentId = agentId
    this.activeMeta = meta
    this.providers = null
    const pageController = new MobilePageController(agentId)
    this.pageController = pageController
    this.pageUnsubscribe = pageController.subscribeCurrentPage((page) => {
      if (gen !== this.connectGeneration) return
      dispatch('page-changed', { page })
    })
    this.setStatus({ state: 'connecting', message: 'Connecting…', updatedAt: Date.now() })
    dispatch('agent-switched', { agentId, meta })
    dispatch('error', { message: null })
    dispatch('providers-changed', { providers: null })
    dispatch('sessions-listed', { sessions: [] })

    oldPageController?.dispose()
    if (oldSession) {
      await bridge.activeAgent.clearEndpoint().catch(() => {})
      await oldSession.stop().catch(() => {})
    }
    if (gen !== this.connectGeneration) return

    const isCurrent = () => gen === this.connectGeneration

    let session: MobileBackend
    try {
      session = await createMobileBackend({
        agentId,
        baseUrl: remoteConfig.baseUrl,
        agentToken: remoteConfig.agentToken,
        clientPages: pageController.pageTools,
        clientId: 'mobile',
        clientKind: 'mobile',
        isActiveForAgent: () => isCurrent() && this.activeAgentId === agentId,
        onLocalDbChange: (change) => {
          if (!isCurrent()) return
          dispatch('db-change', { change })
        },
        onSnapshotApplied: () => {
          if (!isCurrent()) return
          dispatch('snapshot-applied')
        },
        onStatus: (status) => {
          if (!isCurrent()) return
          const wasConnected = this.status.state === 'connected'
          this.setStatus(status)
          if (status.state === 'connected' && !wasConnected) {
            const sessionId = this.rememberedSessionIds.get(agentId) ?? preferredSessionId
            void this.refreshAfterReconnect(isCurrent, sessionId)
          }
        },
        onEvent: (event) => {
          if (!isCurrent()) return
          this.handleBackendEvent(event)
        },
      })
    } catch (err) {
      if (!isCurrent()) return
      const message = messageFromUnknown(err)
      this.activeAgentId = null
      this.activeMeta = null
      this.pageUnsubscribe?.()
      this.pageUnsubscribe = null
      this.pageController?.dispose()
      this.pageController = null
      this.setStatus({ state: 'error', message: `Connect failed: ${message}`, updatedAt: Date.now() })
      dispatch('agent-switched', { agentId: null, meta: null })
      dispatch('page-changed', { page: null })
      dispatch('error', { message })
      dispatch('set-screen', { screen: 'add-agent' })
      return
    }

    if (!isCurrent()) {
      if (this.pageController === pageController) {
        this.pageUnsubscribe?.()
        this.pageUnsubscribe = null
        this.pageController = null
      }
      pageController.dispose()
      await session.stop().catch(() => {})
      return
    }

    try {
      await bridge.activeAgent.setEndpoint(agentId, remoteConfig.baseUrl, remoteConfig.agentToken)
    } catch (err) {
      console.warn('[backend-session] setEndpoint failed:', err)
    }

    if (!isCurrent()) {
      await bridge.activeAgent.clearEndpoint().catch(() => {})
      await session.stop().catch(() => {})
      return
    }

    this.session = session
    void this.loadInitialBackendState(isCurrent, preferredSessionId)
  }

  async disconnect(): Promise<void> {
    this.connectGeneration += 1
    const oldSession = this.session
    const oldPageController = this.pageController
    this.pageUnsubscribe?.()
    this.pageUnsubscribe = null
    this.session = null
    this.pageController = null
    this.activeAgentId = null
    this.activeMeta = null
    this.providers = null
    this.setStatus({ ...IDLE_STATUS })
    dispatch('agent-switched', { agentId: null, meta: null })
    dispatch('page-changed', { page: null })
    dispatch('providers-changed', { providers: null })
    dispatch('sessions-listed', { sessions: [] })

    oldPageController?.dispose()
    if (oldSession) {
      await bridge.activeAgent.clearEndpoint().catch(() => {})
      await oldSession.stop().catch(() => {})
    }
  }

  // ── Disconnect driven by intent event ───────────────────────────────────

  private async handleDisconnect(agentId: string): Promise<void> {
    if (this.activeAgentId !== agentId) return
    await this.disconnect()
  }

  // ── Removal driven by intent event ──────────────────────────────────────

  private async handleRemove(agentId: string): Promise<void> {
    const wasActive = this.activeAgentId === agentId
    if (wasActive) await this.disconnect()
    await agentRegistry.remove(agentId)
    if (!wasActive) return
    const remaining = agentRegistry.getAgents()
    if (remaining.length > 0) {
      await this.connect(remaining[0].agentId)
    } else {
      dispatch('set-screen', { screen: 'add-agent' })
    }
  }

  // ── Session actions ──────────────────────────────────────────────────────

  /** Load a session and broadcast it as a session-state fact. Returns the
   *  loaded state for callers that need the raw shape (e.g. the chat
   *  component on mount). */
  async loadSession(sessionId: string): Promise<SessionState | null> {
    const session = this.session
    if (!session) return null
    const gen = this.connectGeneration
    try {
      const state = await session.backend.sessions.get({ sessionId })
      if (gen !== this.connectGeneration) return null
      if (state) {
        this.rememberSession(state.sessionId)
        dispatch('session-state', {
          sessionId: state.sessionId,
          title: state.title ?? null,
          messages: state.messages,
          live: state.live,
        })
      } else {
        // The session was deleted on the daemon (or never existed). Drop
        // the remembered id and tell the UI so it stops rendering stale
        // content for a session that no longer exists.
        this.forgetSession(sessionId)
        dispatch('session-removed', { sessionId })
      }
      return state ?? null
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      dispatch('error', { message: `Loading session failed: ${messageFromUnknown(err)}` })
      return null
    }
  }

  /** Spawn a new session under the chosen provider with this prompt.
   *  Returns the new session id on success or null on failure (and
   *  dispatches an error event in the failure path). Awaited directly by
   *  chat_input so the composer can restore the textarea on failure. */
  async sendDraft(req: {
    providerId: string
    text: string
    files?: FileContent[]
  }): Promise<string | null> {
    if (!this.guardConnected() || !this.guardPrompt(req.text, req.files)) return null
    const session = this.session
    if (!session) return null
    const gen = this.connectGeneration
    try {
      const { sessionId } = await session.backend.sessions.spawn({
        prompt: req.text.trim() || ' ',
        providerId: req.providerId,
        files: req.files,
      })
      if (gen !== this.connectGeneration) return null
      this.rememberSession(sessionId)
      dispatch('error', { message: null })
      // session:created from the daemon arrives too; load now so the chat
      // mounts with content immediately.
      await this.loadSession(sessionId)
      return sessionId
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      dispatch('error', { message: `Starting session failed: ${messageFromUnknown(err)}` })
      return null
    }
  }

  /** Append a follow-up message to an existing session. Returns true on
   *  success, false on failure (with an error event already dispatched). */
  async sendFollowup(sessionId: string, req: {
    text: string
    files?: FileContent[]
  }): Promise<boolean> {
    if (!this.guardConnected() || !this.guardPrompt(req.text, req.files)) return false
    const session = this.session
    if (!session) return false
    const gen = this.connectGeneration
    try {
      await session.backend.sessions.send({
        sessionId,
        text: req.text.trim() || ' ',
        files: req.files,
      })
      if (gen !== this.connectGeneration) return false
      this.rememberSession(sessionId)
      dispatch('error', { message: null })
      return true
    } catch (err) {
      if (gen !== this.connectGeneration) return false
      dispatch('error', { message: `Sending message failed: ${messageFromUnknown(err)}` })
      return false
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    const session = this.session
    if (!session) return
    if (!this.isConnected()) {
      dispatch('error', { message: 'Remote agent is disconnected. Reconnect before aborting.' })
      return
    }
    const gen = this.connectGeneration
    try {
      await session.backend.sessions.abort({ sessionId })
      if (gen !== this.connectGeneration) return
      dispatch('error', { message: null })
    } catch (err) {
      if (gen !== this.connectGeneration) return
      dispatch('error', { message: `Abort failed: ${messageFromUnknown(err)}` })
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.session
    if (!session) return
    const gen = this.connectGeneration
    this.forgetSession(sessionId)
    try {
      await session.backend.sessions.remove({ sessionId })
      if (gen !== this.connectGeneration) return
      dispatch('session-removed', { sessionId })
    } catch (err) {
      if (gen !== this.connectGeneration) return
      dispatch('error', { message: `Removing session failed: ${messageFromUnknown(err)}` })
    }
  }

  // ── Refresh helpers ──────────────────────────────────────────────────────

  async refreshSessions(): Promise<SessionSummary[]> {
    const session = this.session
    if (!session) return []
    const gen = this.connectGeneration
    try {
      const sessions = await session.backend.sessions.list()
      if (gen !== this.connectGeneration) return []
      const sorted = sortSessions(sessions)
      dispatch('sessions-listed', { sessions: sorted })
      return sorted
    } catch (err) {
      if (gen !== this.connectGeneration) return []
      console.warn('[backend-session] sessions.list failed:', err)
      return []
    }
  }

  async refreshProviders(): Promise<ProviderState | null> {
    const session = this.session
    if (!session) return null
    const gen = this.connectGeneration
    try {
      const providers = await session.backend.providers.getState()
      if (gen !== this.connectGeneration) return null
      this.providers = providers
      dispatch('providers-changed', { providers })
      return providers
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      console.warn('[backend-session] providers.getState failed:', err)
      return null
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private guardConnected(): boolean {
    if (!this.session) {
      dispatch('error', { message: 'Remote agent is not connected.' })
      return false
    }
    if (!this.isConnected()) {
      dispatch('error', { message: 'Remote agent is disconnected. Wait for it to reconnect before sending.' })
      return false
    }
    return true
  }

  private guardPrompt(text: string, files?: FileContent[]): boolean {
    const hasFiles = (files?.length ?? 0) > 0
    if (!text.trim() && !hasFiles) {
      dispatch('error', { message: 'Prompt is required.' })
      return false
    }
    return true
  }

  private setStatus(status: BackendStatusSnapshot): void {
    this.status = status
    dispatch('status-changed', { status })
  }

  private async loadInitialBackendState(
    isCurrent: () => boolean,
    preferredSessionId: string | null,
  ): Promise<void> {
    await Promise.all([this.refreshProviders(), this.refreshSessions()])
    if (preferredSessionId && isCurrent()) await this.loadSession(preferredSessionId)
  }

  private async refreshAfterReconnect(
    isCurrent: () => boolean,
    preferredSessionId: string | null,
  ): Promise<void> {
    await Promise.all([this.refreshProviders(), this.refreshSessions()])
    if (preferredSessionId && isCurrent()) await this.loadSession(preferredSessionId)
  }

  private handleBackendEvent(event: AgentBackendEvent): void {
    switch (event.kind) {
      case 'session:state':
        dispatch('session-state', {
          sessionId: event.sessionId,
          title: event.title,
          messages: event.messages,
          live: event.live,
        })
        return
      case 'session:created':
        dispatch('session-created', { summary: event.summary })
        return
      case 'session:removed':
        this.forgetSession(event.sessionId)
        dispatch('session-removed', { sessionId: event.sessionId })
        return
      case 'session:saved':
      case 'session:loaded':
        void this.refreshSessions()
        return
      case 'task:started':
      case 'task:finished':
        return
    }
  }

  private rememberSession(sessionId: string): void {
    if (this.activeAgentId) this.rememberedSessionIds.set(this.activeAgentId, sessionId)
  }

  private forgetSession(sessionId: string): void {
    if (!this.activeAgentId) return
    if (this.rememberedSessionIds.get(this.activeAgentId) === sessionId) {
      this.rememberedSessionIds.delete(this.activeAgentId)
    }
  }
}

export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export const backendSession = new BackendSession()
