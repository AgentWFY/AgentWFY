// Cross-component communication is plain window-level CustomEvents — no bus
// class, no central state. Intents and facts share one namespace; the verb
// makes intent vs fact clear.
//
//   Intent events  (UI emits; services handle):
//     set-screen, switch-agent, remove-agent, disconnect-agent,
//     open-session, close-session, remove-session, start-draft,
//     cancel-draft, abort-session, open-view, close-view, reload-view
//
//   Fact events    (services emit; UI listens):
//     agents-changed, agent-switched, status-changed, db-change,
//     snapshot-applied, page-changed, session-state, session-created,
//     session-removed, sessions-listed, providers-changed, error
//
// Components that own a slice of UI state (e.g. <awfy-app> owns the router
// state) emit their own focused facts via dispatch() as needed.

import type {
  BackendStatusSnapshot,
  ProviderState,
  SessionState,
  SessionSummary,
} from '#shared/backend/interface.js'
import type { AgentDbChange } from '#shared/db/sqlite.js'
import type { PageHostInfo } from '#shared/page/types.js'
import type {
  TaskRunFinishedPayload,
  TaskRunLogPayload,
  TaskRunStartedPayload,
} from '#shared/task-runner/task_runner.js'
import type { InstalledAgent, AgentMeta } from './agent-meta.js'

export type Screen = 'add-agent' | 'chat' | 'views' | 'tasks'

export interface MobileEventMap {
  // ─── Intents ────────────────────────────────────────────────────────────
  'set-screen': { screen: Screen }
  'switch-agent': { agentId: string }
  'remove-agent': { agentId: string }
  'disconnect-agent': { agentId: string }
  'open-session': { sessionId: string }
  'close-session': void
  'remove-session': { sessionId: string }
  'start-draft': { providerId: string }
  'cancel-draft': void
  'abort-session': { sessionId: string }
  'open-view': { name: string }
  'close-view': void
  'reload-view': void

  // ─── Facts ──────────────────────────────────────────────────────────────
  'agents-changed': { agents: InstalledAgent[] }
  'agent-switched': { agentId: string | null; meta: AgentMeta | null }
  'status-changed': { status: BackendStatusSnapshot }
  'db-change': { change: AgentDbChange }
  'snapshot-applied': void
  'page-changed': { page: PageHostInfo | null }
  'session-state': {
    sessionId: string
    providerId?: string | null
    title?: string | null
    messages?: SessionState['messages']
    live?: SessionState['live']
  }
  'session-created': { summary: SessionSummary }
  'session-removed': { sessionId: string }
  'sessions-listed': { sessions: SessionSummary[] }
  'providers-changed': { providers: ProviderState | null }
  'task-run-started': { payload: TaskRunStartedPayload }
  'task-run-log': { payload: TaskRunLogPayload }
  'task-run-finished': { payload: TaskRunFinishedPayload }
  'error': { message: string | null }
}

const PREFIX = 'awfy-mobile:'

type EventName = keyof MobileEventMap
type EventDetail<K extends EventName> = MobileEventMap[K]

export function dispatch<K extends EventName>(
  name: K,
  ...args: EventDetail<K> extends void ? [] : [detail: EventDetail<K>]
): void {
  const detail = (args[0] ?? undefined) as EventDetail<K> | undefined
  window.dispatchEvent(new CustomEvent(PREFIX + name, { detail }))
}

export function listen<K extends EventName>(
  name: K,
  handler: (detail: EventDetail<K>) => void,
): () => void {
  const wrapped = (evt: Event) => {
    handler((evt as CustomEvent).detail as EventDetail<K>)
  }
  const channel = PREFIX + name
  window.addEventListener(channel, wrapped)
  return () => window.removeEventListener(channel, wrapped)
}
