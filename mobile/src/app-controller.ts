// Mobile app state/controller layer.
//
// Owns the single active remote agent: installed-agents list, active agent
// id, backend connection, status, sessions, providers, views, screen. UI code
// subscribes to AppState and calls controller methods; it never reaches into
// RemoteBackend or the Tauri bridge directly.
//
// Persistence model matches desktop: an ordered list of agent ids in
// `installedAgents` and per-agent metadata in `installedAgentMeta` (see
// agent-meta.ts). No mobile-only abstractions on top.

import type {
  AgentBackendEvent,
  BackendStatusSnapshot,
  ProviderState,
  SessionState,
  SessionSummary,
  SpawnSessionRequest,
} from '#shared/backend/interface.js'
import type { FileContent } from '#shared/agent/types.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'
import {
  addInstalledAgent,
  listInstalledAgents,
  removeInstalledAgent,
  setAgentMeta,
  type AgentMeta,
  type InstalledAgent,
  type RemoteAgentConfig,
} from './agent-meta.js'
import { createMobileBackend, type MobileBackend } from './backend.js'
import { bridge } from './tauri-bridge.js'

export type Screen = 'add-agent' | 'chat' | 'views'

export interface ViewSummary {
  name: string
  title: string | null
}

export interface AppState {
  screen: Screen
  /** Installed agents loaded from disk; refreshed after add/remove. */
  agents: InstalledAgent[]
  /** Agent id the live backend is for, or null when disconnected. */
  activeAgentId: string | null
  /** Cached meta for the active agent so chat/view surfaces can read host
   *  config without a follow-up await. Mirrors `agents[i].meta` for
   *  activeAgentId. */
  activeMeta: AgentMeta | null
  status: BackendStatusSnapshot
  sessions: SessionSummary[]
  activeSession: SessionState | null
  providers: ProviderState | null
  views: ViewSummary[]
  /** Name of the view currently open in the view frame, or null. */
  activeViewName: string | null
  /** When non-null, the user has tapped "New session" and picked a provider.
   *  We're showing the compose surface but haven't spawned a session yet —
   *  the first sendMessage() call will create it under this provider. */
  draftProviderId: string | null
  /** Monotonic counter bumped whenever the active view's iframe should be
   *  reloaded (user clicked Reload, snapshot was applied, or the underlying
   *  `views` row changed). Used as a query-param on the iframe src so the
   *  WebView treats it as a fresh navigation. */
  viewVersion: number
  /** Wall-clock of the most recent mirror snapshot/apply, for diagnostics. */
  lastSyncAt: number | null
  /** Last mirror DB change observed, for diagnostics. */
  lastDbChange: AgentDbChange | null
  error: string | null
}

export interface SendMessageRequest {
  text: string
  providerId?: string
  providerOptions?: Record<string, unknown>
  files?: FileContent[]
}

const IDLE_STATUS: BackendStatusSnapshot = {
  state: 'disconnected',
  message: '',
  updatedAt: 0,
}

function initialState(): AppState {
  return {
    // Placeholder — bootstrap picks the real screen (chat once an agent is
    // active, or add-agent when nothing is installed). Mirrors desktop where
    // the first persisted agent is selected by default.
    screen: 'add-agent',
    agents: [],
    activeAgentId: null,
    activeMeta: null,
    // Spread so callers can't accidentally mutate the module-level constant.
    status: { ...IDLE_STATUS },
    sessions: [],
    activeSession: null,
    providers: null,
    views: [],
    activeViewName: null,
    draftProviderId: null,
    viewVersion: 0,
    lastSyncAt: null,
    lastDbChange: null,
    error: null,
  }
}

export class AppController {
  private state: AppState = initialState()
  private readonly subscribers = new Set<(state: AppState) => void>()

  private session: MobileBackend | null = null
  private readonly rememberedActiveSessionIds = new Map<string, string>()
  /** Increments on every connect()/disconnect() so callbacks captured by a
   *  prior attempt can detect they've been superseded and no-op. Critical
   *  for races where the underlying mirror emits a buffered change after
   *  stop() has been called on the surface but before its in-flight await
   *  resolves. */
  private connectGeneration = 0

  getState(): AppState {
    return this.state
  }

  subscribe(handler: (state: AppState) => void): () => void {
    this.subscribers.add(handler)
    // Push the current state synchronously so subscribers don't need a
    // separate "render once at startup" call. The patch() fanout snapshots
    // its subscribers list first, so a handler that calls subscribe()
    // during fanout doesn't get double-invoked.
    handler(this.state)
    return () => {
      this.subscribers.delete(handler)
    }
  }

  /** Returns the live backend, or null if disconnected. Exposed so chat/view
   *  surfaces in later steps can call session/provider/runtime APIs directly
   *  rather than re-proxying everything through the controller. Callers
   *  MUST NOT cache the reference across a disconnect — RemoteBackend.stop()
   *  clears its event/dbChange subscriber sets, so any subscribers attached
   *  via the backend object will be silently dropped. Re-fetch on reconnect. */
  getBackend(): MobileBackend['backend'] | null {
    return this.session?.backend ?? null
  }

  setScreen(screen: Screen): void {
    if (this.state.screen === screen) return
    this.patch({ screen })
  }

  /** Load the installed-agents list from disk. Safe to call repeatedly. */
  async refreshAgents(): Promise<InstalledAgent[]> {
    try {
      const agents = await listInstalledAgents()
      this.patch({ agents, error: null })
      return agents
    } catch (err) {
      this.patch({ error: `Loading agents failed: ${messageFromUnknown(err)}` })
      return []
    }
  }

  /** Persist a new remote agent. Mirrors desktop's add-remote-agent
   *  command-palette action (command-palette/manager.ts): trim + require
   *  agentId/baseUrl/agentToken, baseUrl must start with http(s)://, strip
   *  a trailing slash. Throws on validation failure so the form can surface
   *  the message inline.
   *
   *  Does NOT connect — the caller decides when to switch screens and call
   *  connect(), so connect errors land on the destination screen instead of
   *  a form DOM that has already been replaced by the screen flip. Returns
   *  the normalized agent id. */
  async addRemoteAgent(input: {
    agentId: string
    baseUrl: string
    agentToken: string
  }): Promise<string> {
    const agentId = input.agentId.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/$/, '')
    const agentToken = input.agentToken.trim()
    if (!agentId) throw new Error('Local label is required')
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      throw new Error('Server URL must start with http:// or https://')
    }
    if (!agentToken) throw new Error('Bearer token is required')

    const meta: AgentMeta = { remoteConfig: { baseUrl, agentToken } }
    await setAgentMeta(agentId, meta)
    await addInstalledAgent(agentId)
    await this.refreshAgents()
    return agentId
  }

  /** Remove an installed agent. Disconnects first if it's the active one.
   *  After the removal, the renderer needs *some* agent to focus on (the
   *  agents-list screen is gone): connect to the next remaining agent, or
   *  drop to add-agent when nothing is left. */
  async removeAgent(agentId: string): Promise<void> {
    const wasActive = this.state.activeAgentId === agentId
    if (wasActive) {
      await this.disconnect()
    }
    await removeInstalledAgent(agentId)
    const agents = await this.refreshAgents()
    if (!wasActive) return
    if (agents.length > 0) {
      void this.connect(agents[0].agentId)
    } else {
      this.patch({ screen: 'add-agent' })
    }
  }

  /** Connect to an installed agent by id. */
  async connect(agentId: string): Promise<void> {
    const agent = this.state.agents.find((a) => a.agentId === agentId)
    if (!agent) {
      this.patch({ error: `Unknown agent: ${agentId}` })
      return
    }
    const remoteConfig = agent.meta.remoteConfig

    const gen = ++this.connectGeneration
    const preferredSessionId = this.state.activeAgentId === agentId
      ? this.state.activeSession?.sessionId ?? this.rememberedActiveSessionIds.get(agentId) ?? null
      : this.rememberedActiveSessionIds.get(agentId) ?? null

    // Patch 'connecting' synchronously so the UI updates immediately. Flip
    // to the chat screen so connect errors appear next to the Disconnect /
    // Remove controls that recover from them. Reset per-agent state
    // (sessions/activeSession/providers/views) so a switch from A→B never
    // shows A's session list under B's header.
    this.patch({
      screen: 'chat',
      activeAgentId: agentId,
      activeMeta: agent.meta,
      status: { state: 'connecting', message: 'Connecting…', updatedAt: Date.now() },
      error: null,
      sessions: [],
      activeSession: null,
      providers: null,
      views: [],
      activeViewName: null,
      draftProviderId: null,
      viewVersion: 0,
      lastDbChange: null,
      lastSyncAt: null,
    })

    await this.teardownSession()
    if (gen !== this.connectGeneration) return

    // Capture gen in callbacks so events arriving after a superseding
    // connect/disconnect have a clean "am I current?" check. Without this,
    // a buffered db change drained after mirror.stop() can patch lastDbChange
    // onto post-disconnect state.
    const isCurrent = () => gen === this.connectGeneration

    let session: MobileBackend
    try {
      session = await createMobileBackend({
        agentId,
        baseUrl: remoteConfig.baseUrl,
        agentToken: remoteConfig.agentToken,
        onLocalDbChange: (change) => {
          if (!isCurrent()) return
          this.patch({ lastDbChange: change, lastSyncAt: Date.now() })
          if (change.table === 'views') {
            void this.handleViewsChange(isCurrent)
          }
        },
        onSnapshotApplied: () => {
          if (!isCurrent()) return
          // Snapshot replacement may have rewritten every row in `views` —
          // refresh the catalog and force the active iframe to reload so
          // stale content (or a deleted view) doesn't keep rendering.
          this.patch({
            lastSyncAt: Date.now(),
            viewVersion: this.state.viewVersion + 1,
          })
          void this.refreshViews(isCurrent)
        },
        onStatus: (status) => {
          if (!isCurrent()) return
          const previousState = this.state.status.state
          this.patch({ status })
          if (status.state === 'connected' && previousState !== 'connected') {
            const currentSession = this.session
            if (!currentSession) return
            const sessionId = this.state.activeSession?.sessionId
              ?? this.rememberedActiveSessionIds.get(agentId)
              ?? preferredSessionId
            void this.refreshAfterReconnect(currentSession, isCurrent, sessionId)
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
      // Bounce back to add-agent so the renderer doesn't keep showing a chat
      // header for an agent that never connected. The sidebar stays available
      // so the user can pick another agent; the error surfaces as a banner.
      this.patch({
        screen: 'add-agent',
        activeAgentId: null,
        activeMeta: null,
        status: { state: 'error', message: `Connect failed: ${message}`, updatedAt: Date.now() },
        error: message,
      })
      return
    }

    if (!isCurrent()) {
      // Superseded while createMobileBackend was in flight. Drop the
      // freshly-built session; the endpoint has not been touched yet so the
      // superseding connect owns it.
      await session.stop().catch(() => {})
      return
    }

    // Set the endpoint BEFORE committing this.session. A concurrent
    // disconnect's teardownSession sees this.session == null and skips
    // clearEndpoint — so the only way an endpoint can be leaked past
    // disconnect is if we lose the gen check on the next await. The
    // post-await re-check below catches that.
    try {
      await bridge.activeAgent.setEndpoint(agentId, remoteConfig.baseUrl, remoteConfig.agentToken)
    } catch (err) {
      console.warn('[app-controller] setEndpoint failed:', err)
    }

    if (!isCurrent()) {
      // A disconnect/connect superseded us during the setEndpoint await.
      // The superseding flow's teardownSession saw this.session == null and
      // didn't clear the endpoint, so we must roll back the endpoint we
      // just set and drop our session ourselves.
      await bridge.activeAgent.clearEndpoint().catch(() => {})
      await session.stop().catch(() => {})
      return
    }

    this.session = session

    // Kick off provider + session loads. Both run under the same generation
    // guard as connect itself — a superseding disconnect/connect won't see
    // a late-arriving response patched onto its state.
    void this.loadInitialBackendState(session, isCurrent, preferredSessionId)
  }

  private async loadInitialBackendState(
    session: MobileBackend,
    isCurrent: () => boolean,
    preferredSessionId: string | null,
  ): Promise<void> {
    await Promise.all([
      this.refreshProviders(session, isCurrent),
      this.refreshSessions(session, isCurrent),
      this.refreshViews(isCurrent),
    ])
    await this.restoreActiveSession(session, isCurrent, preferredSessionId)
  }

  private async refreshAfterReconnect(
    session: MobileBackend,
    isCurrent: () => boolean,
    preferredSessionId: string | null,
  ): Promise<void> {
    await Promise.all([
      this.refreshProviders(session, isCurrent),
      this.refreshSessions(session, isCurrent),
      this.refreshViews(isCurrent),
      this.restoreActiveSession(session, isCurrent, preferredSessionId),
    ])
  }

  private async refreshProviders(
    session: MobileBackend,
    isCurrent: () => boolean,
  ): Promise<void> {
    try {
      const providers = await session.backend.providers.getState()
      if (!isCurrent()) return
      this.patch({ providers })
    } catch (err) {
      if (!isCurrent()) return
      console.warn('[app-controller] providers.getState failed:', err)
    }
  }

  private async refreshSessions(
    session: MobileBackend,
    isCurrent: () => boolean,
  ): Promise<void> {
    try {
      const sessions = await session.backend.sessions.list()
      if (!isCurrent()) return
      this.patch({ sessions: sortSessions(sessions) })
    } catch (err) {
      if (!isCurrent()) return
      console.warn('[app-controller] sessions.list failed:', err)
    }
  }

  /** Query the mirrored `views` table for name/title and update state. Mirrors
   *  the ORDER BY used by shared/db/views.ts:listViews so the mobile list
   *  matches what desktop's command palette / source explorer show. */
  private async refreshViews(isCurrent: () => boolean): Promise<void> {
    const agentId = this.state.activeAgentId
    if (!agentId) return
    try {
      const rows = await bridge.mirrorDb.query(
        agentId,
        `SELECT name, title FROM views
ORDER BY
  CASE
    WHEN name NOT LIKE 'system.%' AND name NOT LIKE 'plugin.%' THEN 0
    WHEN name LIKE 'system.%' THEN 1
    WHEN name LIKE 'plugin.%' THEN 2
  END,
  updated_at DESC`,
      )
      if (!isCurrent()) return
      const views: ViewSummary[] = rows.map((row) => ({
        name: String(row.name ?? ''),
        title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      })).filter((v) => v.name.length > 0)

      // If the active view was deleted between snapshots, drop it so the
      // frame doesn't keep rendering the daemon's "View not found" stub.
      const active = this.state.activeViewName
      const stillPresent = active === null || views.some((v) => v.name === active)
      const patch: Partial<AppState> = { views }
      if (!stillPresent) {
        patch.activeViewName = null
        patch.error = `View "${active}" was removed.`
      }
      this.patch(patch)
    } catch (err) {
      if (!isCurrent()) return
      console.warn('[app-controller] views refresh failed:', err)
    }
  }

  /** Called when a row in the `views` table changes. Refreshes the catalog
   *  and, if the change targets the active view, bumps viewVersion so the
   *  iframe reloads with the new content. */
  private async handleViewsChange(isCurrent: () => boolean): Promise<void> {
    const change = this.state.lastDbChange
    await this.refreshViews(isCurrent)
    if (!isCurrent()) return
    const active = this.state.activeViewName
    if (!active) return
    // change.rowId is the view's `name` (primary key). Updates that rename a
    // view carry the old key in previousRowId; treat either match as "the
    // active view changed".
    if (change && (change.rowId === active || change.previousRowId === active)) {
      this.patch({ viewVersion: this.state.viewVersion + 1 })
    }
  }

  /** Open a view in the view frame and switch to the views screen. */
  openView(name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    if (this.state.activeViewName === trimmed) {
      this.patch({ screen: 'views', error: null })
      return
    }
    this.patch({
      screen: 'views',
      activeViewName: trimmed,
      viewVersion: this.state.viewVersion + 1,
      error: null,
    })
  }

  /** Close the active view without leaving the views screen. */
  closeView(): void {
    if (this.state.activeViewName === null) return
    this.patch({ activeViewName: null })
  }

  /** Force the active view's iframe to reload. */
  reloadView(): void {
    if (this.state.activeViewName === null) return
    this.patch({ viewVersion: this.state.viewVersion + 1 })
  }

  /** Load a session's full state into `activeSession`. Returns the loaded
   *  state, or null if the session doesn't exist on the daemon (e.g. it was
   *  removed between the list and the tap). */
  async loadSession(sessionId: string): Promise<SessionState | null> {
    const session = this.session
    if (!session) return null
    const gen = this.connectGeneration
    try {
      const state = await session.backend.sessions.get({ sessionId })
      if (gen !== this.connectGeneration) return null
      if (state) this.rememberActiveSession(state.sessionId)
      else this.forgetActiveSession(sessionId)
      this.patch({ activeSession: state ?? null, error: null })
      return state ?? null
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      this.patch({ error: `Loading session failed: ${messageFromUnknown(err)}` })
      return null
    }
  }

  /** Spawn a new session via the daemon. On success, loads the freshly-
   *  created session into `activeSession` so the UI can show it without
   *  waiting for a list refresh. */
  async newSession(req: SpawnSessionRequest): Promise<string | null> {
    const session = this.session
    if (!session) return null
    const gen = this.connectGeneration
    try {
      const { sessionId } = await session.backend.sessions.spawn(req)
      if (gen !== this.connectGeneration) return null
      this.rememberActiveSession(sessionId)
      this.patch({ error: null })
      await this.loadSession(sessionId)
      return sessionId
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      this.patch({ error: `Starting session failed: ${messageFromUnknown(err)}` })
      return null
    }
  }

  /** Remove a session from the daemon. Clears `activeSession` first if it
   *  matches so the UI doesn't briefly render a session that's already
   *  being torn down. */
  async removeSession(sessionId: string): Promise<void> {
    const session = this.session
    if (!session) return
    const gen = this.connectGeneration
    if (this.state.activeSession?.sessionId === sessionId) {
      this.patch({ activeSession: null })
    }
    this.forgetActiveSession(sessionId)
    try {
      await session.backend.sessions.remove({ sessionId })
      if (gen !== this.connectGeneration) return
      // Patch the list locally; the session:removed event will also fire and
      // re-trigger a refresh, but doing it here makes the row disappear
      // before the daemon's event echoes back.
      this.patch({
        sessions: this.state.sessions.filter((s) => s.sessionId !== sessionId),
      })
    } catch (err) {
      if (gen !== this.connectGeneration) return
      this.patch({ error: `Removing session failed: ${messageFromUnknown(err)}` })
    }
  }

  /** Clear the active session without touching the daemon. */
  closeSession(): void {
    if (this.state.activeSession === null) return
    this.forgetActiveSession(this.state.activeSession.sessionId)
    this.patch({ activeSession: null })
  }

  /** Begin a "new session" draft. The compose surface opens with the chosen
   *  provider locked in; the first sendMessage() spawns the session. */
  startDraft(providerId: string): void {
    const id = providerId.trim()
    if (!id) return
    this.patch({
      screen: 'chat',
      activeSession: null,
      draftProviderId: id,
      error: null,
    })
  }

  /** Abandon a draft, returning to the session list. */
  cancelDraft(): void {
    if (this.state.draftProviderId === null) return
    this.patch({ draftProviderId: null })
  }

  async sendMessage(req: SendMessageRequest): Promise<string | null> {
    const session = this.session
    if (!session) {
      this.patch({ error: 'Remote agent is not connected.' })
      return null
    }
    if (this.state.status.state !== 'connected') {
      this.patch({ error: 'Remote agent is disconnected. Wait for it to reconnect before sending.' })
      return null
    }

    const text = req.text.trim()
    const hasFiles = (req.files?.length ?? 0) > 0
    if (!text && !hasFiles) {
      this.patch({ error: 'Prompt is required.' })
      return null
    }

    const active = this.state.activeSession
    if (!active) {
      const providerId = req.providerId ?? this.state.draftProviderId ?? undefined
      // Keep draftProviderId set across the spawn so the renderer stays on the
      // draft surface (instead of flickering through the picker) until
      // activeSession lands. activeSession takes render precedence, then
      // draftProviderId clears once newSession returns successfully.
      const sessionId = await this.newSession({
        prompt: text || ' ',
        providerId,
        providerOptions: req.providerOptions,
        files: req.files,
      })
      if (sessionId !== null && this.state.draftProviderId !== null) {
        this.patch({ draftProviderId: null })
      }
      return sessionId
    }

    const gen = this.connectGeneration
    try {
      await session.backend.sessions.send({
        sessionId: active.sessionId,
        text: text || ' ',
        files: req.files,
      })
      if (gen !== this.connectGeneration) return null
      this.rememberActiveSession(active.sessionId)
      this.patch({ error: null })
      return active.sessionId
    } catch (err) {
      if (gen !== this.connectGeneration) return null
      this.patch({ error: `Sending message failed: ${messageFromUnknown(err)}` })
      return null
    }
  }

  async abortActiveSession(): Promise<void> {
    const session = this.session
    const active = this.state.activeSession
    if (!session || !active) return
    if (this.state.status.state !== 'connected') {
      this.patch({ error: 'Remote agent is disconnected. Reconnect before aborting.' })
      return
    }

    const gen = this.connectGeneration
    try {
      await session.backend.sessions.abort({ sessionId: active.sessionId })
      if (gen !== this.connectGeneration) return
      this.patch({ error: null })
    } catch (err) {
      if (gen !== this.connectGeneration) return
      this.patch({ error: `Abort failed: ${messageFromUnknown(err)}` })
    }
  }

  async disconnect(): Promise<void> {
    this.connectGeneration += 1
    await this.teardownSession()
    this.patch({
      ...initialState(),
      // Preserve the loaded agents list so the UI doesn't have to re-fetch,
      // and the current screen so callers (removeAgent / menu actions) can
      // decide where to navigate next.
      agents: this.state.agents,
      screen: this.state.screen,
    })
  }

  private async teardownSession(): Promise<void> {
    const session = this.session
    this.session = null
    if (!session) return
    // Only clear the Rust endpoint when we had an active session committed;
    // otherwise the surviving connect's endpoint would be wiped.
    await bridge.activeAgent.clearEndpoint().catch(() => {})
    await session.stop().catch(() => {})
  }

  private handleBackendEvent(event: AgentBackendEvent): void {
    switch (event.kind) {
      case 'session:state': {
        const active = this.state.activeSession
        let sessions = this.state.sessions
        if (event.title !== undefined) {
          sessions = sessions.map((s) => (
            s.sessionId === event.sessionId ? { ...s, title: event.title ?? s.title } : s
          ))
        }
        if (active && active.sessionId === event.sessionId) {
          const next: SessionState = {
            ...active,
            messages: event.messages ?? active.messages,
            title: event.title ?? active.title,
            live: event.live,
          }
          this.rememberActiveSession(next.sessionId)
          this.patch({ activeSession: next, sessions })
        } else if (sessions !== this.state.sessions) {
          this.patch({ sessions })
        }
        return
      }
      case 'session:created': {
        // Merge the new summary in. The daemon also emits session:saved
        // shortly after as the first turn streams; that will refetch to pick
        // up the title update.
        const filtered = this.state.sessions.filter((s) => s.sessionId !== event.summary.sessionId)
        this.patch({ sessions: sortSessions([event.summary, ...filtered]) })
        return
      }
      case 'session:removed': {
        this.forgetActiveSession(event.sessionId)
        const sessions = this.state.sessions.filter((s) => s.sessionId !== event.sessionId)
        const activeSession =
          this.state.activeSession?.sessionId === event.sessionId ? null : this.state.activeSession
        this.patch({ sessions, activeSession })
        return
      }
      case 'session:saved':
      case 'session:loaded': {
        // Title / updatedAt may have changed. Refetch the list so the
        // picker stays accurate. Fire-and-forget — the refresh helper
        // guards against late responses.
        const session = this.session
        if (!session) return
        const gen = this.connectGeneration
        void this.refreshSessions(session, () => gen === this.connectGeneration)
        return
      }
      case 'task:started':
      case 'task:finished':
        return
    }
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    // Snapshot subscribers before iterating so:
    //   - a subscriber registered during fanout (via subscribe()) isn't
    //     visited twice — it gets the synchronous push in subscribe() and
    //     is not in this iteration list.
    //   - a subscriber removed by another handler mid-iteration is skipped
    //     via the has() check rather than receiving the patch after it
    //     already unsubscribed.
    const subs = Array.from(this.subscribers)
    for (const sub of subs) {
      if (this.subscribers.has(sub)) sub(this.state)
    }
  }

  private async restoreActiveSession(
    session: MobileBackend,
    isCurrent: () => boolean,
    sessionId: string | null,
  ): Promise<void> {
    if (!sessionId || !isCurrent()) return
    const current = this.state.activeSession
    if (current && current.sessionId !== sessionId) return
    try {
      const state = await session.backend.sessions.get({ sessionId })
      if (!isCurrent()) return
      const latest = this.state.activeSession
      if (latest && latest.sessionId !== sessionId) return
      if (state) {
        this.rememberActiveSession(state.sessionId)
        this.patch({ activeSession: state, error: null })
      } else {
        this.forgetActiveSession(sessionId)
      }
    } catch (err) {
      if (!isCurrent()) return
      console.warn('[app-controller] restore active session failed:', err)
    }
  }

  private rememberActiveSession(sessionId: string): void {
    const agentId = this.state.activeAgentId
    if (!agentId) return
    this.rememberedActiveSessionIds.set(agentId, sessionId)
  }

  private forgetActiveSession(sessionId: string, agentId: string | null = this.state.activeAgentId): void {
    if (agentId) {
      if (this.rememberedActiveSessionIds.get(agentId) === sessionId) {
        this.rememberedActiveSessionIds.delete(agentId)
      }
      return
    }
    for (const [rememberedAgentId, remembered] of this.rememberedActiveSessionIds) {
      if (remembered === sessionId) this.rememberedActiveSessionIds.delete(rememberedAgentId)
    }
  }
}

export type { InstalledAgent, AgentMeta, RemoteAgentConfig }

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}
