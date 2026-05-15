// RemoteBackend — environment-neutral AgentBackend implementation that talks
// to remote-backend-server. Transport (WebSocket, reconnect, RPC envelope) is
// delegated to WsClient in ./ws_client.ts. This file is purely the
// AgentBackend translation layer: shape the protocol methods into the
// AgentBackend API surface, fan out events/db-changes, and route incoming
// server-initiated client.functions.invoke RPCs to the desktop's client
// function registry.
//
// Constraints:
//   - No Electron imports
//   - No node:* imports
//   - No DOM globals except the standard WebSocket/fetch-style globals

import {
  DB_SNAPSHOT_PATH,
  errorFromUnknown,
  formatAuthHeader,
  type ClientFunctionsInvokeRequest,
  type ClientFunctionsInvokeResponse,
  type ConfigClearRequest,
  type ConfigMutationResponse,
  type ConfigRemoveRequest,
  type ConfigSetRequest,
  type FunctionsInvokeRequest,
  type FunctionsInvokeResponse,
  type FunctionsListResponse,
  type ProvidersGetStateResponse,
  type ProvidersGetStatusLineRequest,
  type ProvidersGetStatusLineResponse,
  type ProvidersListResponse,
  type ProvidersSetDefaultRequest,
  type ProvidersSetDefaultResponse,
  type SessionsAbortRequest,
  type SessionsGetRequest,
  type SessionsGetResponse,
  type SessionsListRequest,
  type SessionsListResponse,
  type SessionsRemoveRequest,
  type SessionsSendRequest,
  type SessionsSpawnRequest,
  type SessionsSpawnResponse,
  type TasksListRunningResponse,
  type TasksStartRequest,
  type TasksStartResponse,
  type TasksStopRequest,
  type TasksStopResponse,
  type WireError,
  type WsMessage,
  type WsRpcRequest,
} from './protocol.js'
import type {
  AgentBackend,
  AgentBackendEvent,
  BackendKind,
  BackendStatusSnapshot,
  ConfigApi,
  EventsApi,
  FunctionInfo,
  FunctionsApi,
  ProvidersApi,
  SessionHandle,
  SessionState,
  SessionSummary,
  SessionsApi,
  StatusApi,
  TasksApi,
  Unsubscribe,
} from './interface.js'
import type { AgentDbChange } from '../db/sqlite.js'
import { isClientRuntimeFunction } from '../runtime/client-functions.js'
import { WsClient, WsClientError, type WsClientConfig } from './ws_client.js'

export { WsClientError as RemoteBackendError }

export interface RemoteBackendConfig extends WsClientConfig {
  /** Stable identifier for this backend instance (e.g. the agent slug). */
  id: string
  /** Desktop-local runtime functions that should be callable through this backend
   *  and from the daemon via client.functions.invoke. */
  desktopFunctions?: RemoteDesktopFunctions
}

export interface RemoteDesktopFunctions {
  getMethodNames(): string[]
  has(name: string): boolean
  call(name: string, params: unknown): Promise<unknown>
}

export interface RemoteDbSync {
  start(): Promise<void>
  stop(): void
  runSql(payload: unknown): Promise<unknown[]>
}

export class RemoteBackend implements AgentBackend {
  readonly kind: BackendKind = 'remote'
  readonly id: string

  private readonly ws: WsClient
  private readonly baseUrl: string
  private readonly agentToken: string
  private readonly desktopFunctions: RemoteDesktopFunctions | undefined

  private readonly eventSubscribers = new Set<(event: AgentBackendEvent) => void>()
  private readonly dbChangeSubscribers = new Set<(change: AgentDbChange) => void>()
  private dbSync: RemoteDbSync | null = null

  constructor(config: RemoteBackendConfig) {
    this.id = config.id
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.agentToken = config.agentToken
    this.desktopFunctions = config.desktopFunctions
    this.ws = new WsClient(config)
    this.ws.setMessageHandler((message) => this.handleWsMessage(message))
  }

  attachDbSync(dbSync: RemoteDbSync): void {
    this.dbSync = dbSync
  }

  async start(): Promise<void> {
    await this.ws.start()
    await this.dbSync?.start()
  }

  async stop(): Promise<void> {
    this.dbSync?.stop()
    await this.ws.stop()
    this.eventSubscribers.clear()
    this.dbChangeSubscribers.clear()
  }

  readonly sessions: SessionsApi = {
    list: async (req): Promise<SessionSummary[]> => {
      return this.ws.rpc<SessionsListRequest, SessionsListResponse>('sessions.list', req ?? {})
    },
    get: async (req): Promise<SessionState | null> => {
      return this.ws.rpc<SessionsGetRequest, SessionsGetResponse>('sessions.get', req)
    },
    spawn: async (req): Promise<SessionHandle> => {
      return this.ws.rpc<SessionsSpawnRequest, SessionsSpawnResponse>('sessions.spawn', req)
    },
    send: async (req): Promise<void> => {
      await this.ws.rpc<SessionsSendRequest, { ok: true }>('sessions.send', req)
    },
    abort: async (req): Promise<void> => {
      await this.ws.rpc<SessionsAbortRequest, { ok: true }>('sessions.abort', req)
    },
    remove: async (req): Promise<void> => {
      await this.ws.rpc<SessionsRemoveRequest, { ok: true }>('sessions.remove', req)
    },
  }

  readonly functions: FunctionsApi = {
    list: async () => {
      const remoteList = await this.ws.rpc<Record<string, never>, FunctionsListResponse>('functions.list', {})
      const merged = new Map<string, FunctionInfo>()
      for (const info of remoteList) merged.set(info.name, info)
      if (this.desktopFunctions) {
        for (const name of this.desktopFunctions.getMethodNames()) {
          if (!merged.has(name)) merged.set(name, { name })
        }
      }
      return [...merged.values()]
    },
    invoke: async (req): Promise<unknown> => {
      if (req.name === 'runSql' && this.dbSync) {
        return this.dbSync.runSql(req.params)
      }
      if (isClientRuntimeFunction(req.name) && this.desktopFunctions?.has(req.name)) {
        return this.desktopFunctions.call(req.name, req.params)
      }
      return this.invokeRemoteFunction(req)
    },
  }

  readonly providers: ProvidersApi = {
    list: async () => {
      return this.ws.rpc<Record<string, never>, ProvidersListResponse>('providers.list', {})
    },
    getState: async () => {
      return this.ws.rpc<Record<string, never>, ProvidersGetStateResponse>('providers.getState', {})
    },
    getStatusLine: async (providerId: string) => {
      const { statusLine } = await this.ws.rpc<ProvidersGetStatusLineRequest, ProvidersGetStatusLineResponse>(
        'providers.getStatusLine',
        { providerId },
      )
      return statusLine
    },
    setDefault: async (providerId: string) => {
      return this.ws.rpc<ProvidersSetDefaultRequest, ProvidersSetDefaultResponse>(
        'providers.setDefault',
        { providerId },
      )
    },
  }

  readonly config: ConfigApi = {
    set: async (name, value) => {
      await this.ws.rpc<ConfigSetRequest, ConfigMutationResponse>('config.set', { name, value })
    },
    clear: async (name) => {
      await this.ws.rpc<ConfigClearRequest, ConfigMutationResponse>('config.clear', { name })
    },
    remove: async (name) => {
      await this.ws.rpc<ConfigRemoveRequest, ConfigMutationResponse>('config.remove', { name })
    },
  }

  readonly tasks: TasksApi = {
    start: async ({ taskName, input, origin }) => {
      return this.ws.rpc<TasksStartRequest, TasksStartResponse>('tasks.start', { taskName, input, origin })
    },
    stop: async ({ runId }) => {
      await this.ws.rpc<TasksStopRequest, TasksStopResponse>('tasks.stop', { runId })
    },
    listRunning: async () => {
      return this.ws.rpc<Record<string, never>, TasksListRunningResponse>('tasks.listRunning', {})
    },
  }

  readonly events: EventsApi = {
    subscribe: (handler: (event: AgentBackendEvent) => void): Unsubscribe => {
      this.eventSubscribers.add(handler)
      return () => {
        this.eventSubscribers.delete(handler)
      }
    },
  }

  readonly status: StatusApi = {
    get: (): BackendStatusSnapshot => this.ws.status.get(),
    subscribe: (handler: (status: BackendStatusSnapshot) => void): Unsubscribe => {
      return this.ws.status.subscribe(handler)
    },
  }

  getAgentDbSnapshotRequest(): { url: string; headers: Record<string, string> } {
    return {
      url: `${this.baseUrl}${DB_SNAPSHOT_PATH}`,
      headers: {
        authorization: formatAuthHeader(this.agentToken),
      },
    }
  }

  subscribeDbChanges(handler: (change: AgentDbChange) => void): Unsubscribe {
    this.dbChangeSubscribers.add(handler)
    return () => {
      this.dbChangeSubscribers.delete(handler)
    }
  }

  async invokeRemoteFunction(req: FunctionsInvokeRequest): Promise<unknown> {
    const { value } = await this.ws.rpc<FunctionsInvokeRequest, FunctionsInvokeResponse>(
      'functions.invoke',
      req,
    )
    return value
  }

  private async handleWsMessage(message: WsMessage): Promise<void> {
    switch (message.type) {
      case 'hello':
        return
      case 'event':
        this.emit(message.event)
        return
      case 'db:changed':
        this.emitDbChange(message.change)
        return
      case 'rpc':
        await this.handleServerRpc(message)
        return
      default:
        return
    }
  }

  private async handleServerRpc(message: WsRpcRequest): Promise<void> {
    if (message.method !== 'client.functions.invoke') {
      this.sendRpcError(message.id, { name: 'UnknownMethod', message: `Unknown client RPC method: ${message.method}` })
      return
    }

    if (!this.desktopFunctions) {
      this.sendRpcError(message.id, {
        name: 'ClientFunctionUnavailable',
        message: 'Client function registry is not available in this runtime',
      })
      return
    }

    try {
      const req = message.params as ClientFunctionsInvokeRequest
      const value = await this.desktopFunctions.call(req.name, req.params)
      const result: ClientFunctionsInvokeResponse = { value }
      this.ws.send({ type: 'rpc:result', id: message.id, ok: true, value: result })
    } catch (err) {
      this.sendRpcError(message.id, errorFromUnknown(err))
    }
  }

  private sendRpcError(id: string, error: WireError): void {
    this.ws.send({ type: 'rpc:result', id, ok: false, error })
  }

  private emit(event: AgentBackendEvent): void {
    for (const handler of this.eventSubscribers) {
      try {
        handler(event)
      } catch (err) {
        console.error('[RemoteBackend] subscriber threw:', err)
      }
    }
  }

  private emitDbChange(change: AgentDbChange): void {
    for (const handler of this.dbChangeSubscribers) {
      try {
        handler(change)
      } catch (err) {
        console.error('[RemoteBackend] db change subscriber threw:', err)
      }
    }
  }
}
