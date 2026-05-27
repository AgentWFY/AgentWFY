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
import type { AgentSessionManager } from '../agent/session_manager.js'
import { sanitizeStreamingMessage } from '../agent/session_manager.js'
import { stripBlockBinaries } from '../agent/session_persistence.js'
import type { FunctionRegistry } from '../runtime/function_registry.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { TaskRunner } from '../task-runner/task_runner.js'
import type { TraceWriter } from '../runtime/trace_writer.js'
import { getConfigValue, setAgentConfig, clearAgentConfig, removeAgentConfig } from '../settings/config.js'
import { SystemConfigKeys } from '../system-config/keys.js'
import { readAgentFile, statAgentFile } from './files.js'
import { listAgentTaskLogHistory, readAgentTaskLog } from './task-logs.js'
import { listAgentTraces } from './traces.js'
import {
  backupAgentDb,
  getBackupStatus,
  listAllBackups,
  restoreFromBackup,
} from '../backup.js'

/** Minimal slice of per-agent runtime that LocalBackend actually uses.
 *  Importing this (vs. the full AgentContext) keeps LocalBackend free of
 *  desktop-only type deps (TabViewManager, ShortcutManager, etc.). */
export interface LocalBackendContext {
  /** Stable identity used as the backend id. */
  agentId: string
  /** Filesystem root where the live runtime owns on-disk data. */
  runtimeRoot: string
  sessionManager: AgentSessionManager
  functionRegistry: FunctionRegistry
  providerRegistry: ProviderRegistry
  taskRunner: TaskRunner
  traceWriter: TraceWriter
}
import {
  type AgentBackend,
  type AgentBackendEvent,
  type BackendStatusSnapshot,
  type BackendKind,
  type BackupApi,
  type EventsApi,
  type FilesApi,
  type FunctionsApi,
  type ProvidersApi,
  type ConfigApi,
  type TasksApi,
  type TracesApi,
  type RunningTaskSummary,
  type SessionHandle,
  type SessionLivePatch,
  type SessionState,
  type SessionsApi,
  type StatusApi,
  type SpawnSessionRequest,
  type Unsubscribe,
} from './interface.js'

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
  private agentEventsUnsubscribe: (() => void) | null = null
  private sessionLifecycleUnsubscribe: (() => void) | null = null
  private taskLifecycleUnsubscribe: (() => void) | null = null
  private started = false

  constructor(ctx: LocalBackendContext) {
    this.ctx = ctx
    this.id = ctx.agentId
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Per-session typed event stream: every tracked agent's events fan out as
    // session:state (live always, messages only when the array reference
    // changes). Session save/load fan out as their own typed events.
    this.agentEventsUnsubscribe = this.ctx.sessionManager.subscribeToAgentEvents(
      (sessionId, event) => {
        if (event.type === 'session_saved') {
          this.emit({ kind: 'session:saved', sessionId: event.sessionId })
          return
        }
        if (event.type === 'session_loaded') {
          this.emit({ kind: 'session:loaded', sessionId: event.sessionId })
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

    this.taskLifecycleUnsubscribe = this.ctx.taskRunner.subscribeLifecycle({
      onRunStarted: (payload) => this.emit({ kind: 'task:started', payload }),
      onRunLog: (payload) => this.emit({ kind: 'task:log', payload }),
      onRunFinished: (payload) => this.emit({ kind: 'task:finished', payload }),
    })
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.agentEventsUnsubscribe?.()
    this.agentEventsUnsubscribe = null
    this.sessionLifecycleUnsubscribe?.()
    this.sessionLifecycleUnsubscribe = null
    this.taskLifecycleUnsubscribe?.()
    this.taskLifecycleUnsubscribe = null
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
        files: req.files,
      })
      let state: SessionState | null = null
      try {
        state = await this.sessions.get({ sessionId })
      } catch (err) {
        console.warn('[LocalBackend] failed to build session:created summary:', err)
      }
      this.emit({
        kind: 'session:created',
        summary: state
          ? {
              sessionId: state.sessionId,
              title: state.title,
              providerId: state.providerId,
              updatedAt: state.updatedAt,
            }
          : {
              sessionId,
              title: 'New session',
              providerId: req.providerId ?? '',
              updatedAt: Date.now(),
            },
      })
      return { sessionId }
    },

    send: async ({ sessionId, text, files }) => {
      await this.ctx.sessionManager.sendToSession(sessionId, text, { autoPublishResponse: false, files })
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
    readRun: async ({ runId }) => {
      return this.ctx.taskRunner.readTaskRun(runId)
    },
    listLogHistory: async () => {
      return listAgentTaskLogHistory(this.ctx.runtimeRoot)
    },
    readLog: async ({ logFileName }) => {
      return readAgentTaskLog(this.ctx.runtimeRoot, logFileName)
    },
  }

  readonly files: FilesApi = {
    read: async ({ path, offset, limit }) => {
      return readAgentFile(this.ctx.runtimeRoot, path, { offset, limit })
    },
    stat: async ({ path }) => {
      return statAgentFile(this.ctx.runtimeRoot, path)
    },
  }

  readonly traces: TracesApi = {
    list: async ({ sessionId }) => {
      await this.ctx.traceWriter.flush(sessionId)
      return listAgentTraces(this.ctx.runtimeRoot, sessionId)
    },
  }

  readonly backup: BackupApi = {
    create: async () => backupAgentDb(this.ctx.runtimeRoot),
    restore: async ({ version }) => restoreFromBackup(this.ctx.runtimeRoot, version),
    list: async () => listAllBackups(this.ctx.runtimeRoot),
    status: async () => getBackupStatus(this.ctx.runtimeRoot),
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
