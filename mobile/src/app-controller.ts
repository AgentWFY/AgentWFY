// Mobile app state/controller layer.
//
// Owns the single active remote agent: profile, backend connection, status,
// sessions, providers, views, screen. UI code subscribes to AppState and
// calls controller methods; it never reaches into RemoteBackend or the
// Tauri bridge directly. Sessions/providers/views start empty here — Steps
// 4 and 7 populate them.

import type {
  AgentBackendEvent,
  BackendStatusSnapshot,
  ProviderState,
  SessionState,
  SessionSummary,
} from '#shared/backend/interface.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import { messageFromUnknown } from '#shared/backend/protocol.js'
import { createMobileBackend, type MobileBackend } from './backend.js'
import { bridge } from './tauri-bridge.js'

export type Screen = 'connect' | 'chat' | 'views'

export interface ProfileFields {
  agentId: string
  baseUrl: string
  agentToken: string
}

export interface ViewSummary {
  name: string
  title: string | null
  description: string | null
}

export interface AppState {
  screen: Screen
  profile: ProfileFields | null
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
    screen: 'connect',
    profile: null,
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

  async connect(profile: ProfileFields): Promise<void> {
    const gen = ++this.connectGeneration

    // Patch 'connecting' synchronously so the UI updates immediately,
    // before the (potentially slow) teardown of a previous session.
    this.patch({
      profile,
      status: { state: 'connecting', message: 'Connecting…', updatedAt: Date.now() },
      error: null,
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
        agentId: profile.agentId,
        baseUrl: profile.baseUrl,
        agentToken: profile.agentToken,
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
      this.patch({
        status: { state: 'error', message: `Connect failed: ${message}`, updatedAt: Date.now() },
        error: message,
      })
      return
    }

    if (!isCurrent()) {
      // A second connect()/disconnect() superseded this one while
      // createMobileBackend was in flight. Drop the freshly-built session
      // without touching bridge.activeAgent — the endpoint is owned by
      // whichever connect committed.
      await session.stop().catch(() => {})
      return
    }

    this.session = session

    // Tell the Rust URI scheme handler about the active daemon endpoint
    // AFTER we commit the session, so a discarded (superseded) connect
    // can't race a setEndpoint with a later clearEndpoint.
    await bridge.activeAgent
      .setEndpoint(profile.agentId, profile.baseUrl, profile.agentToken)
      .catch((err) => {
        console.warn('[app-controller] setEndpoint failed:', err)
      })
  }

  async disconnect(): Promise<void> {
    this.connectGeneration += 1
    await this.teardownSession()
    this.patch({
      ...initialState(),
      // Preserve the last-used profile so the UI can prefill on retry.
      profile: this.state.profile,
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
