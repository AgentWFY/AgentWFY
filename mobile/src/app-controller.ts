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
} from '#shared/backend/interface.js'
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

export type Screen = 'agents' | 'add-agent' | 'chat' | 'views'

export interface ViewSummary {
  name: string
  title: string | null
  description: string | null
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
  /** Wall-clock of the most recent mirror snapshot/apply, for diagnostics. */
  lastSyncAt: number | null
  /** Last mirror DB change observed, for diagnostics. */
  lastDbChange: AgentDbChange | null
  error: string | null
}

const IDLE_STATUS: BackendStatusSnapshot = {
  state: 'disconnected',
  message: '',
  updatedAt: 0,
}

function initialState(): AppState {
  return {
    screen: 'agents',
    agents: [],
    activeAgentId: null,
    activeMeta: null,
    // Spread so callers can't accidentally mutate the module-level constant.
    status: { ...IDLE_STATUS },
    sessions: [],
    activeSession: null,
    providers: null,
    views: [],
    lastSyncAt: null,
    lastDbChange: null,
    error: null,
  }
}

export class AppController {
  private state: AppState = initialState()
  private readonly subscribers = new Set<(state: AppState) => void>()

  private session: MobileBackend | null = null
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

  /** Remove an installed agent. Disconnects first if it's the active one. */
  async removeAgent(agentId: string): Promise<void> {
    if (this.state.activeAgentId === agentId) {
      await this.disconnect()
    }
    await removeInstalledAgent(agentId)
    await this.refreshAgents()
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
        },
        onSnapshotApplied: () => {
          if (!isCurrent()) return
          this.patch({ lastSyncAt: Date.now() })
        },
        onStatus: (status) => {
          if (!isCurrent()) return
          this.patch({ status })
        },
        onEvent: (event) => {
          if (!isCurrent()) return
          this.handleBackendEvent(event)
        },
      })
    } catch (err) {
      if (!isCurrent()) return
      const message = messageFromUnknown(err)
      // Bounce back to the agents list so the renderer doesn't keep showing
      // a chat header for an agent that never connected, and the user lands
      // somewhere they can retry / remove.
      this.patch({
        screen: 'agents',
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
  }

  async disconnect(): Promise<void> {
    this.connectGeneration += 1
    await this.teardownSession()
    this.patch({
      ...initialState(),
      // Preserve the loaded agents list so the UI doesn't have to re-fetch.
      agents: this.state.agents,
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
    // Sessions/providers wiring lands in Step 4 — for now the controller
    // just owns the shape so consumers can subscribe without a second
    // refactor later.
    switch (event.kind) {
      case 'session:state': {
        const active = this.state.activeSession
        if (active && active.sessionId === event.sessionId) {
          const next: SessionState = {
            ...active,
            messages: event.messages ?? active.messages,
            title: event.title ?? active.title,
            live: event.live,
          }
          this.patch({ activeSession: next })
        }
        return
      }
      case 'session:created':
      case 'session:removed':
      case 'session:saved':
      case 'session:loaded':
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
}

export type { InstalledAgent, AgentMeta, RemoteAgentConfig }
