// LocalBackend — in-process AgentBackend implementation that wraps the
// existing per-agent AgentContext. Pure delegation: nothing new happens
// inside; this file only re-exposes today's surfaces behind the contract
// in ./interface.ts so the renderer (and later RemoteBackend's daemon)
// can talk to "an agent" through a single uniform shape.
//
// This file may freely import Electron-touching code — it is the bridge
// between Electron-bound AgentContext and the environment-neutral interface.

import type { AgentState } from '../agent/types.js'
import type { DisplayMessage } from '../agent/provider_types.js'
import type { EventBus } from '../event-bus.js'
import type { AgentSessionManager } from '../agent/session_manager.js'
import { sanitizeStreamingMessage } from '../agent/session_manager.js'
import { stripBlockBinaries } from '../agent/session_persistence.js'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { TaskRunner } from '../task-runner/task_runner.js'
import { getConfigValue, setAgentConfig, clearAgentConfig, removeAgentConfig } from '../settings/config.js'
import { SystemConfigKeys } from '../system-config/keys.js'

/** Minimal slice of per-agent runtime that LocalBackend actually uses.
 *  Importing this (vs. the full AgentContext) keeps LocalBackend free of
 *  desktop-only type deps (TabViewManager, ShortcutManager, etc.). */
export interface LocalBackendContext {
  /** Stable identity used as the backend id. */
  agentId: string
  /** Filesystem root where the live runtime owns on-disk data. */
  runtimeRoot: string
  eventBus: EventBus
  sessionManager: AgentSessionManager
  functionRegistry: FunctionRegistry
  providerRegistry: ProviderRegistry
  taskRunner: TaskRunner
}
import {
  BUS_TOPICS,
  type AgentBackend,
  type AgentBackendEvent,
  type BackendStatusSnapshot,
  type BackendKind,
  type EventsApi,
  type FunctionsApi,
  type ProvidersApi,
  type ConfigApi,
  type TasksApi,
  type RunningTaskSummary,
  type SessionHandle,
  type SessionLivePatch,
  type SessionState,
  type SessionsApi,
  type StatusApi,
  type SpawnSessionRequest,
  type Unsubscribe,
} from './interface.js'

const SESSION_BUS_TOPICS = {
  saved:  'sessions.saved',
  loaded: 'sessions.loaded',
} as const

function liveStateFromAgentState(state: AgentState): SessionLivePatch {
  return {
    isStreaming: state.isStreaming,
    streamingMessage: sanitizeStreamingMessage(state.streamingMessage),
    statusLine: state.statusLine,
    retryState: state.retryState ?? null,
    stalledSince: state.stalledSince ?? null,
  }
}

export class LocalBackend implements AgentBackend {
  readonly kind: BackendKind = 'local'
  readonly id: string

  private readonly ctx: LocalBackendContext
  private readonly subscribers = new Set<(event: AgentBackendEvent) => void>()
  private readonly lastMessagesRef = new Map<string, DisplayMessage[]>()
  private readonly lastTitle = new Map<string, string>()
  private busUnsubscribes: Array<() => void> = []
  private agentEventsUnsubscribe: (() => void) | null = null
  private sessionLifecycleUnsubscribe: (() => void) | null = null
  private started = false

  constructor(ctx: LocalBackendContext) {
    this.ctx = ctx
    this.id = ctx.agentId
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Forward known bus topics into the unified event stream. Unknown topics
    // stay invisible to backend subscribers — by design, since
    // plugins/views consume their own topics via runtime functions.
    for (const topic of Object.values(BUS_TOPICS)) {
      const off = this.ctx.eventBus.subscribe(topic, (data) => {
        this.emit({ kind: 'bus', topic, data })
      })
      this.busUnsubscribes.push(off)
    }

    // Per-session typed event stream: every tracked agent's events fan out as
    // session:state (live always, messages only when the array reference
    // changes). session_saved/loaded become bus events.
    this.agentEventsUnsubscribe = this.ctx.sessionManager.subscribeToAgentEvents(
      (sessionId, event) => {
        if (event.type === 'session_saved') {
          this.emit({
            kind: 'bus',
            topic: SESSION_BUS_TOPICS.saved,
            data: { sessionId: event.sessionId },
          })
          return
        }
        if (event.type === 'session_loaded') {
          this.emit({
            kind: 'bus',
            topic: SESSION_BUS_TOPICS.loaded,
            data: { sessionId: event.sessionId },
          })
          return
        }

        const state = this.ctx.sessionManager.getSessionAgentState(sessionId)
        if (!state) return

        const messagesChanged = this.lastMessagesRef.get(sessionId) !== state.messages
        if (messagesChanged) {
          this.lastMessagesRef.set(sessionId, state.messages)
        }

        const title = this.ctx.sessionManager.getSessionTitle(sessionId) ?? ''
        const titleChanged = this.lastTitle.get(sessionId) !== title
        if (titleChanged) {
          this.lastTitle.set(sessionId, title)
        }

        this.emit({
          kind: 'session:state',
          sessionId,
          live: liveStateFromAgentState(state),
          ...(messagesChanged ? { messages: stripBlockBinaries(state.messages) } : {}),
          ...(titleChanged ? { title } : {}),
        })
      },
    )

    this.sessionLifecycleUnsubscribe = this.ctx.sessionManager.subscribeToSessionLifecycle({
      onDisposed: ({ sessionId }) => {
        this.lastMessagesRef.delete(sessionId)
        this.lastTitle.delete(sessionId)
      },
      onRemoved: ({ sessionId }) => {
        this.lastMessagesRef.delete(sessionId)
        this.lastTitle.delete(sessionId)
        this.emit({ kind: 'session:removed', sessionId })
      },
    })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    for (const off of this.busUnsubscribes) off()
    this.busUnsubscribes = []
    this.agentEventsUnsubscribe?.()
    this.agentEventsUnsubscribe = null
    this.sessionLifecycleUnsubscribe?.()
    this.sessionLifecycleUnsubscribe = null
    this.subscribers.clear()
    this.lastMessagesRef.clear()
    this.lastTitle.clear()
  }

  // ── sessions ───────────────────────────────────────────────────────────

  readonly sessions: SessionsApi = {
    list: async (req) => {
      return this.ctx.sessionManager.listSessions(req ?? {})
    },

    get: async ({ sessionId }: { sessionId: string }): Promise<SessionState | null> => {
      const result = await this.ctx.sessionManager.readSessionState(sessionId)
      if (!result) return null
      return {
        sessionId: result.sessionId,
        title: result.title,
        providerId: result.providerId,
        updatedAt: result.updatedAt,
        messages: result.messages,
        live: result.state ? liveStateFromAgentState(result.state) : null,
      }
    },

    spawn: async (req: SpawnSessionRequest): Promise<SessionHandle> => {
      const sessionId = await this.ctx.sessionManager.createSession({
        prompt: req.prompt,
        providerId: req.providerId,
        providerOptions: req.providerOptions,
      })
      return { sessionId }
    },

    send: async ({ sessionId, text }) => {
      await this.ctx.sessionManager.sendToSession(sessionId, text, { autoPublishResponse: false })
    },

    abort: async ({ sessionId }) => {
      await this.ctx.sessionManager.abortSession(sessionId)
    },

    remove: async ({ sessionId }) => {
      await this.ctx.sessionManager.removeSession(sessionId)
    },
  }

  // ── functions ──────────────────────────────────────────────────────────

  readonly functions: FunctionsApi = {
    list: async () => {
      return this.ctx.functionRegistry.getFunctionInfo()
    },
    invoke: async ({ name, params }) => {
      return this.ctx.functionRegistry.call(name, params)
    },
    getNamesSync: () => {
      return this.ctx.functionRegistry.getMethodNames()
    },
  }

  readonly providers: ProvidersApi = {
    list: async () => {
      return this.ctx.providerRegistry.list()
    },
    getState: async () => {
      const defaultId = (getConfigValue(
        this.ctx.runtimeRoot,
        SystemConfigKeys.provider,
        'openai-compatible',
      ) as string) || 'openai-compatible'
      const { providers, statusLines } = this.ctx.providerRegistry.listWithStatusLines()
      return {
        providerList: providers,
        defaultProviderId: defaultId,
        providerStatusLines: statusLines,
      }
    },
    getStatusLine: async (providerId: string) => {
      const factory = this.ctx.providerRegistry.get(providerId)
      if (!factory?.getStatusLine) return ''
      return factory.getStatusLine()
    },
    setDefault: async (providerId: string) => {
      setAgentConfig(this.ctx.runtimeRoot, SystemConfigKeys.provider, providerId)
      return this.providers.getState()
    },
  }

  readonly config: ConfigApi = {
    set: async (name, value) => {
      setAgentConfig(this.ctx.runtimeRoot, name, value)
    },
    clear: async (name) => {
      clearAgentConfig(this.ctx.runtimeRoot, name)
    },
    remove: async (name) => {
      removeAgentConfig(this.ctx.runtimeRoot, name)
    },
  }

  readonly tasks: TasksApi = {
    start: async ({ taskName, input, origin }) => {
      const runId = await this.ctx.taskRunner.startTask(taskName, input, origin)
      return { runId }
    },
    stop: async ({ runId }) => {
      this.ctx.taskRunner.stopTask(runId)
    },
    listRunning: async (): Promise<RunningTaskSummary[]> => {
      return this.ctx.taskRunner.listRunning()
    },
  }

  // ── events ─────────────────────────────────────────────────────────────

  readonly events: EventsApi = {
    subscribe: (handler: (event: AgentBackendEvent) => void): Unsubscribe => {
      this.subscribers.add(handler)
      return () => {
        this.subscribers.delete(handler)
      }
    },
  }

  readonly status: StatusApi = {
    get: (): BackendStatusSnapshot => ({
      state: 'connected',
      message: 'Local backend connected',
      updatedAt: Date.now(),
    }),
    subscribe: (handler: (status: BackendStatusSnapshot) => void): Unsubscribe => {
      handler({
        state: 'connected',
        message: 'Local backend connected',
        updatedAt: Date.now(),
      })
      return () => {}
    },
  }

  // ── internal ───────────────────────────────────────────────────────────

  private emit(event: AgentBackendEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event)
      } catch (err) {
        console.error('[LocalBackend] subscriber threw:', err)
      }
    }
  }
}
