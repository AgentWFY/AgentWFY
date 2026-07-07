// Host-neutral backend RPC dispatch + event-stream wiring. Every transport
// that fronts an `AgentBackend` over the WS protocol shares this: the Node
// daemon (`server/index.ts`) and the Cloudflare Durable Object both map a
// `BackendRpcMethod` + params to a result, and both fan backend events, DB
// changes, and DB-reset signals onto their connection's send path.
//
// Free of node:* / Electron / DOM imports — only the wire protocol +
// `AgentBackend`. The one transport concern handled here is base64-encoding
// `files.read` bytes at the JSON-over-WS boundary (`Buffer` is a global on
// both Node and Workers-with-nodejs_compat).

import {
  PROTOCOL_VERSION,
  type BackendRpcMethod,
  type BackupRestoreRequest,
  type ConfigClearRequest,
  type ConfigRemoveRequest,
  type ConfigSetRequest,
  type FilesReadRequest,
  type FilesStatRequest,
  type FunctionsInvokeRequest,
  type ProvidersGetStatusLineRequest,
  type ProvidersSetDefaultRequest,
  type SessionsAbortRequest,
  type SessionsGetRequest,
  type SessionsListRequest,
  type SessionsRemoveRequest,
  type SessionsRemoveQueuedRequest,
  type SessionsSendRequest,
  type SessionsSpawnRequest,
  type TasksReadLogRequest,
  type TasksReadRunRequest,
  type TasksStartRequest,
  type TasksStopRequest,
  type TracesListRequest,
  type WsHello,
  type WsMessage,
} from './protocol.js'
import type { AgentBackend } from './interface.js'
import type { AgentDbChange } from '../db/sql-types.js'

/**
 * The state a transport needs to serve backend RPC and live streams: the
 * `AgentBackend` itself plus its DB change-log. The Node daemon's
 * `RuntimeBundle` and the DO both satisfy this shape (the daemon's extra
 * `dispose` is structurally compatible).
 */
export interface BackendHost {
  backend: AgentBackend
  /** Per-row replication stream from the agent DB. */
  dbChanges: {
    subscribe(handler: (change: AgentDbChange) => void): () => void
  }
  /** One-off "the DB was replaced out-of-band" notifications (currently only
   *  emitted after `backup.restore`). Subscribers re-snapshot. */
  dbResets: {
    subscribe(handler: () => void): () => void
    emit(): void
  }
  /** Current DB change-log version. Read after RPCs / on hello so remote
   *  mirrors can sync their `localVersion`. */
  getDbVersion(): number
}

export async function dispatchBackendRpc(
  method: BackendRpcMethod,
  params: unknown,
  host: BackendHost,
): Promise<unknown> {
  const backend = host.backend
  switch (method) {
    case 'health':
      return { ok: true, protocolVersion: PROTOCOL_VERSION }
    case 'whoami':
      return {
        agentId: backend.id,
        protocolVersion: PROTOCOL_VERSION,
      }
    case 'sessions.list':
      return backend.sessions.list(params as SessionsListRequest)
    case 'sessions.get':
      return backend.sessions.get(params as SessionsGetRequest)
    case 'sessions.spawn':
      return backend.sessions.spawn(params as SessionsSpawnRequest)
    case 'sessions.send':
      await backend.sessions.send(params as SessionsSendRequest)
      return { ok: true }
    case 'sessions.abort':
      await backend.sessions.abort(params as SessionsAbortRequest)
      return { ok: true }
    case 'sessions.remove':
      await backend.sessions.remove(params as SessionsRemoveRequest)
      return { ok: true }
    case 'sessions.removeQueued':
      await backend.sessions.removeQueued(params as SessionsRemoveQueuedRequest)
      return { ok: true }
    case 'functions.list':
      return backend.functions.list()
    case 'functions.invoke': {
      const req = params as FunctionsInvokeRequest
      const value = await backend.functions.invoke(req)
      return { value, dbVersion: host.getDbVersion() }
    }
    case 'providers.list':
      return backend.providers.list()
    case 'providers.getState':
      return backend.providers.getState()
    case 'providers.getStatusLine': {
      const req = params as ProvidersGetStatusLineRequest
      const statusLine = await backend.providers.getStatusLine(req.providerId)
      return { statusLine }
    }
    case 'providers.setDefault': {
      const req = params as ProvidersSetDefaultRequest
      return backend.providers.setDefault(req.providerId)
    }
    case 'config.set': {
      const req = params as ConfigSetRequest
      await backend.config.set(req.name, req.value)
      return { ok: true }
    }
    case 'config.clear': {
      const req = params as ConfigClearRequest
      await backend.config.clear(req.name)
      return { ok: true }
    }
    case 'config.remove': {
      const req = params as ConfigRemoveRequest
      await backend.config.remove(req.name)
      return { ok: true }
    }
    case 'tasks.start': {
      const req = params as TasksStartRequest
      return backend.tasks.start(req)
    }
    case 'tasks.stop': {
      const req = params as TasksStopRequest
      await backend.tasks.stop(req)
      return { ok: true }
    }
    case 'tasks.listRunning':
      return backend.tasks.listRunning()
    case 'tasks.readRun':
      return backend.tasks.readRun(params as TasksReadRunRequest)
    case 'tasks.listLogHistory':
      return backend.tasks.listLogHistory()
    case 'tasks.readLog': {
      const req = params as TasksReadLogRequest
      const content = await backend.tasks.readLog(req)
      return { content }
    }
    case 'traces.list':
      return backend.traces.list(params as TracesListRequest)
    case 'files.read': {
      const result = await backend.files.read(params as FilesReadRequest)
      // Wire is JSON; base64-encode bytes at the WS boundary only.
      return {
        size: result.size,
        offset: result.offset,
        mimeType: result.mimeType,
        contentBase64: Buffer.from(result.content).toString('base64'),
      }
    }
    case 'files.stat':
      return backend.files.stat(params as FilesStatRequest)
    case 'backup.create':
      return backend.backup.create()
    case 'backup.restore': {
      const result = await backend.backup.restore(params as BackupRestoreRequest)
      // The DB file was replaced — every connected mirror is now stale and
      // must re-snapshot. Per-row replication can't describe a wholesale
      // file swap, so emit the dedicated db:reset signal.
      if (result.success) host.dbResets.emit()
      return result
    }
    case 'backup.list':
      return backend.backup.list()
    case 'backup.status':
      return backend.backup.status()
    default:
      throw new Error(`Unknown RPC method: ${method}`)
  }
}

/**
 * Subscribe a connection's `send` to the host's live streams: backend events,
 * per-row DB changes, and DB-reset signals. Each stream carries its own
 * monotonic id. Returns a single unsubscribe that detaches all three.
 */
export function attachBackendStreams(
  host: BackendHost,
  send: (message: WsMessage) => void,
): () => void {
  let nextEventId = 1
  let nextChangeId = 1
  const unsubscribeEvents = host.backend.events.subscribe((event) => {
    send({ type: 'event', id: nextEventId++, event })
  })
  const unsubscribeDbChanges = host.dbChanges.subscribe((change) => {
    send({ type: 'db:changed', id: nextChangeId++, change })
  })
  const unsubscribeDbResets = host.dbResets.subscribe(() => {
    send({ type: 'db:reset' })
  })
  return () => {
    unsubscribeEvents()
    unsubscribeDbChanges()
    unsubscribeDbResets()
  }
}

/** The `hello` frame a transport sends right after accepting a connection. */
export function buildHelloMessage(host: BackendHost): WsHello {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    agentId: host.backend.id,
    dbVersion: host.getDbVersion(),
  }
}
