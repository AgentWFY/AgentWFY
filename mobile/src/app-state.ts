// AppState shape + initial values + pure helpers. Split from app-controller.ts
// so render modules under components/ can import the types without dragging in
// the controller class (and its backend wiring).

import type {
  BackendStatusSnapshot,
  ProviderState,
  SessionState,
  SessionSummary,
} from '#shared/backend/interface.js'
import type { FileContent } from '#shared/agent/types.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import type { AgentMeta, InstalledAgent, RemoteAgentConfig } from './agent-meta.js'

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

export const IDLE_STATUS: BackendStatusSnapshot = {
  state: 'disconnected',
  message: '',
  updatedAt: 0,
}

export function initialState(): AppState {
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

export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export type { InstalledAgent, AgentMeta, RemoteAgentConfig }
