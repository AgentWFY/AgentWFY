// agentwfy-remote-server entry point.
//
// The daemon exposes one authenticated WebSocket. Desktop clients use that
// socket for backend RPC, live backend events, and client-function RPCs sent
// from daemon-side agents back to the connected desktop.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTH_HEADER,
  DB_SNAPSHOT_PATH,
  DB_SNAPSHOT_VERSION_HEADER,
  formatAuthHeader,
  PROTOCOL_VERSION,
  WS_PATH,
  encodeWsMessage,
  errorFromUnknown,
  type BackendRpcMethod,
  type ConfigClearRequest,
  type ConfigRemoveRequest,
  type ConfigSetRequest,
  type FunctionsInvokeRequest,
  type ProvidersGetStatusLineRequest,
  type ProvidersSetDefaultRequest,
  type SessionsAbortRequest,
  type SessionsGetRequest,
  type SessionsListRequest,
  type SessionsRemoveRequest,
  type SessionsSendRequest,
  type SessionsSpawnRequest,
  type TasksStartRequest,
  type TasksStopRequest,
  type WsRpcRequest,
} from '#shared/backend/protocol.js'
import type { RuntimeBundle } from './runtime-bootstrap.js'
import { acceptWebSocket, isWebSocketUpgrade, type WsConnection } from './ws.js'
import { ConnectedClientBridge } from './client-bridge.js'
import { writeAgentDbSnapshotFile } from '#shared/db/agent-db.js'

const DEFAULT_PORT = 9878

function getPort(): number {
  const fromEnv = process.env['AGENTWFY_REMOTE_PORT']
  if (fromEnv) {
    const n = Number(fromEnv)
    if (Number.isFinite(n) && n > 0 && n < 65536) return n
  }
  return DEFAULT_PORT
}

function getRuntimeRoot(): string {
  const v = process.env['AGENTWFY_AGENT_ROOT']
  if (!v || v.trim().length === 0) {
    throw new Error(
      'AGENTWFY_AGENT_ROOT must be set to the absolute path of the agent directory.',
    )
  }
  return v
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
  })
  res.end(body)
}

function extractPresentedToken(req: IncomingMessage): string | null {
  const auth = req.headers[AUTH_HEADER]
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length)
  }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.get('token')
  } catch {
    return null
  }
}

function checkAuth(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) return true
  const presented = extractPresentedToken(req)
  return presented === expected || req.headers[AUTH_HEADER] === formatAuthHeader(expected)
}

async function dispatchBackendRpc(
  method: BackendRpcMethod,
  params: unknown,
  bundle: RuntimeBundle,
  clientBridge: ConnectedClientBridge,
): Promise<unknown> {
  switch (method) {
    case 'health':
      return { ok: true, protocolVersion: PROTOCOL_VERSION }
    case 'whoami':
      return {
        agentId: bundle.backend.id,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tabs: clientBridge.isConnected,
          clientFunctionProxy: clientBridge.isConnected,
        },
      }
    case 'sessions.list':
      return bundle.backend.sessions.list(params as SessionsListRequest)
    case 'sessions.get':
      return bundle.backend.sessions.get(params as SessionsGetRequest)
    case 'sessions.spawn':
      return bundle.backend.sessions.spawn(params as SessionsSpawnRequest)
    case 'sessions.send':
      await bundle.backend.sessions.send(params as SessionsSendRequest)
      return { ok: true }
    case 'sessions.abort':
      await bundle.backend.sessions.abort(params as SessionsAbortRequest)
      return { ok: true }
    case 'sessions.remove':
      await bundle.backend.sessions.remove(params as SessionsRemoveRequest)
      return { ok: true }
    case 'functions.list':
      return bundle.backend.functions.list()
    case 'functions.invoke': {
      const req = params as FunctionsInvokeRequest
      const value = await bundle.backend.functions.invoke(req)
      return { value, dbVersion: bundle.getDbVersion() }
    }
    case 'providers.list':
      return bundle.backend.providers.list()
    case 'providers.getState':
      return bundle.backend.providers.getState()
    case 'providers.getStatusLine': {
      const req = params as ProvidersGetStatusLineRequest
      const statusLine = await bundle.backend.providers.getStatusLine(req.providerId)
      return { statusLine }
    }
    case 'providers.setDefault': {
      const req = params as ProvidersSetDefaultRequest
      return bundle.backend.providers.setDefault(req.providerId)
    }
    case 'config.set': {
      const req = params as ConfigSetRequest
      await bundle.backend.config.set(req.name, req.value)
      return { ok: true }
    }
    case 'config.clear': {
      const req = params as ConfigClearRequest
      await bundle.backend.config.clear(req.name)
      return { ok: true }
    }
    case 'config.remove': {
      const req = params as ConfigRemoveRequest
      await bundle.backend.config.remove(req.name)
      return { ok: true }
    }
    case 'tasks.start': {
      const req = params as TasksStartRequest
      return bundle.backend.tasks.start(req)
    }
    case 'tasks.stop': {
      const req = params as TasksStopRequest
      await bundle.backend.tasks.stop(req)
      return { ok: true }
    }
    case 'tasks.listRunning':
      return bundle.backend.tasks.listRunning()
    default:
      throw new Error(`Unknown RPC method: ${method}`)
  }
}

function attachBackendEvents(bundle: RuntimeBundle, connection: WsConnection): () => void {
  let nextEventId = 1
  return bundle.backend.events.subscribe((event) => {
    connection.send(encodeWsMessage({
      type: 'event',
      id: nextEventId++,
      event,
    }))
  })
}

function attachDbChanges(bundle: RuntimeBundle, connection: WsConnection): () => void {
  let nextEventId = 1
  return bundle.dbChanges.subscribe((change) => {
    connection.send(encodeWsMessage({
      type: 'db:changed',
      id: nextEventId++,
      change,
    }))
  })
}

function handleWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  bundle: RuntimeBundle,
  token: string | null,
  clientBridge: ConnectedClientBridge,
): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== WS_PATH) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  if (!checkAuth(req, token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }

  let unsubscribeEvents: (() => void) | null = null
  let unsubscribeDbChanges: (() => void) | null = null
  const connection: WsConnection = acceptWebSocket(req, socket, head, {
    onMessage: (raw) => {
      let message
      try {
        message = clientBridge.handleTextMessage(raw)
      } catch (err) {
        connection.send(encodeWsMessage({
          type: 'rpc:result',
          id: 'malformed',
          ok: false,
          error: errorFromUnknown(err),
        }))
        return
      }
      if (!message || message.type !== 'rpc') return

      const rpc = message as WsRpcRequest
      void dispatchBackendRpc(rpc.method as BackendRpcMethod, rpc.params, bundle, clientBridge)
        .then((value) => {
          connection.send(encodeWsMessage({ type: 'rpc:result', id: rpc.id, ok: true, value }))
        })
        .catch((err) => {
          connection.send(encodeWsMessage({
            type: 'rpc:result',
            id: rpc.id,
            ok: false,
            error: errorFromUnknown(err),
          }))
        })
    },
    onClose: () => {
      unsubscribeEvents?.()
      unsubscribeDbChanges?.()
      unsubscribeEvents = null
      unsubscribeDbChanges = null
      clientBridge.detach(undefined, connection)
      console.log('agentwfy-remote-server: client disconnected')
    },
    onError: (err) => {
      console.warn('agentwfy-remote-server: websocket error:', err)
    },
  })

  clientBridge.attach(connection)
  unsubscribeEvents = attachBackendEvents(bundle, connection)
  unsubscribeDbChanges = attachDbChanges(bundle, connection)
  connection.send(encodeWsMessage({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    agentId: bundle.backend.id,
    capabilities: { tabs: true, clientFunctionProxy: true },
    dbVersion: bundle.getDbVersion(),
  }))
  console.log('agentwfy-remote-server: client connected')
}

function makeHttpHandler(bundle: RuntimeBundle, token: string | null) {
  return function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === DB_SNAPSHOT_PATH) {
      void sendDbSnapshot(req, res, bundle, token)
      return
    }
    sendPlain(res, 426, `Use WebSocket ${WS_PATH}\n`)
  }
}

async function sendDbSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  bundle: RuntimeBundle,
  token: string | null,
): Promise<void> {
  if (!checkAuth(req, token)) {
    sendPlain(res, 401, 'Unauthorized\n')
    return
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentwfy-db-snapshot-'))
  const snapshotPath = path.join(tmpDir, 'agent.db')
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    void rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    const { version } = await writeAgentDbSnapshotFile(bundle.backend.id, snapshotPath)
    const info = await stat(snapshotPath)
    res.writeHead(200, {
      'content-type': 'application/vnd.sqlite3',
      'content-length': String(info.size),
      'cache-control': 'no-store',
      [DB_SNAPSHOT_VERSION_HEADER]: String(version),
    })
    const stream = createReadStream(snapshotPath)
    stream.on('error', (err) => {
      console.warn('agentwfy-remote-server: snapshot stream failed:', err)
      if (!res.headersSent) {
        sendPlain(res, 500, 'Failed to stream database snapshot\n')
      } else {
        res.destroy(err)
      }
      cleanup()
    })
    stream.on('close', cleanup)
    res.on('close', cleanup)
    stream.pipe(res)
  } catch (err) {
    cleanup()
    console.warn('agentwfy-remote-server: snapshot failed:', err)
    if (!res.headersSent) {
      sendPlain(res, 500, 'Failed to create database snapshot\n')
    } else {
      res.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

async function runServer(): Promise<void> {
  const { createAgentRuntime } = await import('./runtime-bootstrap.js')
  const { readConfig } = await import('./config-file.js')

  const resolveTokenInner = (runtimeRoot: string): string | null => {
    const envToken = process.env['AGENTWFY_REMOTE_TOKEN']
    if (envToken && envToken.trim().length > 0) return envToken
    const config = readConfig(runtimeRoot)
    return config?.token ?? null
  }

  const port = getPort()
  const runtimeRoot = getRuntimeRoot()
  const token = resolveTokenInner(runtimeRoot)
  const clientBridge = new ConnectedClientBridge()

  console.log(`agentwfy-remote-server: starting (protocol ${PROTOCOL_VERSION})`)
  console.log(`  agent root: ${runtimeRoot}`)
  console.log(`  auth: ${token ? 'token required' : 'DISABLED (no token configured)'}`)
  if (!token) {
    console.warn('  warning: anyone reachable can issue commands. Run `init` or set AGENTWFY_REMOTE_TOKEN.')
  }

  const bundle = await createAgentRuntime(runtimeRoot, clientBridge)
  console.log(`  runtime: ready (id=${bundle.backend.id})`)

  const server = createServer(makeHttpHandler(bundle, token))
  server.on('upgrade', (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    handleWebSocket(req, socket as Socket, head, bundle, token, clientBridge)
  })
  server.on('error', (err) => {
    console.error('agentwfy-remote-server: server error:', err)
    process.exitCode = 1
  })

  const shutdown = async (signal: string) => {
    console.log(`agentwfy-remote-server: received ${signal}, shutting down`)
    server.close()
    clientBridge.detach(new Error('Server shutting down'))
    await bundle.dispose().catch((err) => console.warn('dispose failed:', err))
    setTimeout(() => process.exit(0), 100).unref()
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  const host = process.env['AGENTWFY_REMOTE_HOST'] || '127.0.0.1'
  server.listen(port, host, () => {
    console.log(`agentwfy-remote-server: listening on ws://${host}:${port}${WS_PATH}`)
  })
}

async function dispatchCli(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv
  switch (subcommand) {
    case undefined:
    case 'start':
      await runServer()
      return
    case 'init': {
      const { runInit } = await import('./admin.js')
      await runInit(rest[0])
      return
    }
    case 'token': {
      const { runShowToken } = await import('./admin.js')
      runShowToken(rest[0])
      return
    }
    case 'rotate': {
      const { runRotateToken } = await import('./admin.js')
      runRotateToken(rest[0])
      return
    }
    case '-h':
    case '--help':
    case 'help': {
      const { printUsage } = await import('./admin.js')
      printUsage()
      return
    }
    default: {
      const { printUsage } = await import('./admin.js')
      console.error(`error: unknown subcommand: ${subcommand}\n`)
      printUsage()
      process.exit(2)
    }
  }
}

void dispatchCli().catch((err) => {
  console.error('agentwfy-remote-server: fatal:', err)
  process.exit(1)
})
