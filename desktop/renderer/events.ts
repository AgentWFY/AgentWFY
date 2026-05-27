import type {
  AgentDbChange,
  InstalledAgent,
  TabData,
} from './ipc-types/index.js'
import type { AgentSessionState } from './services/agent-session.js'

export interface DesktopEventMap {
  // Intents
  'open-sidebar-panel': { panel: string }
  'toggle-agent-chat': void
  'toggle-task-panel': void
  'focus-chat-input': void
  'load-session': { sessionId: string; label: string }
  'open-session-in-chat': { sessionId: string; label: string }
  'close-current-session': void
  'switch-to-session': { index: number }
  'cycle-session': { direction: number }
  'run-task': { taskName: string; input?: string }

  // Facts
  'agents-changed': { agents: InstalledAgent[] }
  'agent-switched': { agentId: string | null; agents: InstalledAgent[] }
  'agent-state-changed': {
    state: Readonly<AgentSessionState>
    changedKeys: Array<keyof AgentSessionState>
  }
  'views-db-changed': { change: AgentDbChange }
  'tasks-db-changed': void
  'triggers-db-changed': void
  'config-db-changed': { key: string }
  'backup-changed': { version?: number | null; skipped?: boolean; restored?: number | null } | undefined
  'plugin-changed': { message?: string } | undefined
  'tab-selected': { tab: TabData | null }
}

const PREFIX = 'agentwfy:'

type EventName = keyof DesktopEventMap
type EventDetail<K extends EventName> = DesktopEventMap[K]
type DispatchArgs<K extends EventName> =
  EventDetail<K> extends void
    ? []
    : undefined extends EventDetail<K>
      ? [detail?: Exclude<EventDetail<K>, undefined>]
      : [detail: EventDetail<K>]

export function dispatch<K extends EventName>(
  name: K,
  ...args: DispatchArgs<K>
): void {
  const detail = args[0] as EventDetail<K> | undefined
  window.dispatchEvent(new CustomEvent(PREFIX + name, { detail }))
}

export function listen<K extends EventName>(
  name: K,
  handler: (detail: EventDetail<K>) => void,
): () => void {
  const channel = PREFIX + name
  const wrapped = (evt: Event) => {
    handler((evt as CustomEvent).detail as EventDetail<K>)
  }
  window.addEventListener(channel, wrapped)
  return () => window.removeEventListener(channel, wrapped)
}
