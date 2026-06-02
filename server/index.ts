// agentwfy-server entry point.
//
// The daemon exposes one authenticated WebSocket. Desktop clients use that
// socket for backend RPC, live backend events, and client-function RPCs sent
// from daemon-side agents back to the connected desktop.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Socket } from 'node:net'
import { createReadStream, readFileSync } from 'node:fs'
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
  type SessionsSendRequest,
  type SessionsSpawnRequest,
  type TasksReadLogRequest,
  type TasksReadRunRequest,
  type TasksStartRequest,
  type TasksStopRequest,
  type TracesListRequest,
  type WsRpcRequest,
} from '#shared/backend/protocol.js'
import type { RuntimeBundle } from './runtime-bootstrap.js'
import { acceptWebSocket, isWebSocketUpgrade, type WsConnection } from './ws.js'
import { ConnectedClientBridge } from './client-bridge.js'
import { writeAgentDbSnapshotFile } from '#shared/db/agent-db.js'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import { mimeFromPath } from '#shared/runtime/mime.js'
import {
  DEFAULT_SIGNED_URL_TTL_MS,
  SIGNED_URL_PATH_PREFIX,
  decodeRelPath,
  verifyFileUrl,
} from '#shared/backend/signed-urls.js'

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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS')
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
  res.setHeader('access-control-expose-headers', DB_SNAPSHOT_VERSION_HEADER)
  res.setHeader('access-control-max-age', '600')
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
): Promise<unknown> {
  switch (method) {
    case 'health':
      return { ok: true, protocolVersion: PROTOCOL_VERSION }
    case 'whoami':
      return {
        agentId: bundle.backend.id,
        protocolVersion: PROTOCOL_VERSION,
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
    case 'tasks.readRun':
      return bundle.backend.tasks.readRun(params as TasksReadRunRequest)
    case 'tasks.listLogHistory':
      return bundle.backend.tasks.listLogHistory()
    case 'tasks.readLog': {
      const req = params as TasksReadLogRequest
      const content = await bundle.backend.tasks.readLog(req)
      return { content }
    }
    case 'traces.list':
      return bundle.backend.traces.list(params as TracesListRequest)
    case 'files.read': {
      const result = await bundle.backend.files.read(params as FilesReadRequest)
      // Wire is JSON; base64-encode bytes at the WS boundary only.
      return {
        size: result.size,
        offset: result.offset,
        mimeType: result.mimeType,
        contentBase64: Buffer.from(result.content).toString('base64'),
      }
    }
    case 'files.stat':
      return bundle.backend.files.stat(params as FilesStatRequest)
    case 'backup.create':
      return bundle.backend.backup.create()
    case 'backup.restore': {
      const result = await bundle.backend.backup.restore(params as BackupRestoreRequest)
      // The DB file was replaced — every connected mirror is now stale and
      // must re-snapshot. Per-row replication can't describe a wholesale
      // file swap, so emit the dedicated db:reset signal.
      if (result.success) bundle.dbResets.emit()
      return result
    }
    case 'backup.list':
      return bundle.backend.backup.list()
    case 'backup.status':
      return bundle.backend.backup.status()
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

function attachDbResets(bundle: RuntimeBundle, connection: WsConnection): () => void {
  return bundle.dbResets.subscribe(() => {
    connection.send(encodeWsMessage({ type: 'db:reset' }))
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
  let unsubscribeDbResets: (() => void) | null = null
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
      void dispatchBackendRpc(rpc.method as BackendRpcMethod, rpc.params, bundle)
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
      unsubscribeDbResets?.()
      unsubscribeEvents = null
      unsubscribeDbChanges = null
      unsubscribeDbResets = null
      clientBridge.detach(undefined, connection)
      console.log('agentwfy-server: client disconnected')
    },
    onError: (err) => {
      console.warn('agentwfy-server: websocket error:', err)
    },
  })

  clientBridge.attach(connection)
  unsubscribeEvents = attachBackendEvents(bundle, connection)
  unsubscribeDbChanges = attachDbChanges(bundle, connection)
  unsubscribeDbResets = attachDbResets(bundle, connection)
  connection.send(encodeWsMessage({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    agentId: bundle.backend.id,
    dbVersion: bundle.getDbVersion(),
  }))
  console.log('agentwfy-server: client connected')
}

function makeHttpHandler(bundle: RuntimeBundle, runtimeRoot: string, token: string | null) {
  return function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    setCorsHeaders(res)
    if (req.method === 'OPTIONS' && url.pathname === DB_SNAPSHOT_PATH) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === DB_SNAPSHOT_PATH) {
      void sendDbSnapshot(req, res, bundle, token)
      return
    }
    const fileRoute = parseFileRoutePath(url.pathname)
    if (fileRoute) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'GET') {
        void serveAgentFile(req, res, url, bundle, runtimeRoot, token, fileRoute)
        return
      }
      sendPlain(res, 405, 'Method Not Allowed\n')
      return
    }
    sendPlain(res, 426, `Use WebSocket ${WS_PATH}\n`)
  }
}

interface FileRoute {
  agentId: string
  relPath: string
}

function parseFileRoutePath(pathname: string): FileRoute | null {
  // /agent/<encodedAgentId>/files/<encodedPath...>
  if (!pathname.startsWith(`${SIGNED_URL_PATH_PREFIX}/`)) return null
  const rest = pathname.slice(SIGNED_URL_PATH_PREFIX.length + 1)
  const slashIndex = rest.indexOf('/')
  if (slashIndex <= 0) return null
  const encodedAgentId = rest.slice(0, slashIndex)
  const afterAgent = rest.slice(slashIndex + 1)
  const FILES_SEG = 'files/'
  if (!afterAgent.startsWith(FILES_SEG)) return null
  const encodedRelPath = afterAgent.slice(FILES_SEG.length)
  if (encodedRelPath.length === 0) return null
  let agentId: string
  let relPath: string
  try {
    agentId = decodeURIComponent(encodedAgentId)
    relPath = decodeRelPath(encodedRelPath)
  } catch {
    return null
  }
  if (agentId.length === 0 || relPath.length === 0) return null
  return { agentId, relPath }
}

async function serveAgentFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _bundle: RuntimeBundle,
  runtimeRoot: string,
  token: string | null,
  route: FileRoute,
): Promise<void> {
  // The agentId in the URL is a cache-key namespace (so two agents on the
  // same daemon host don't share browser-cached bytes), not an identity
  // claim — the HMAC is what authenticates. We deliberately don't compare
  // it to bundle.backend.id: desktop labels remote agents with whatever the
  // user typed during add-remote, which is decoupled from the daemon's
  // runtime root.
  let exp: number | null = null
  if (token !== null) {
    const sig = url.searchParams.get('sig')
    const expRaw = url.searchParams.get('exp')
    const parsedExp = expRaw === null ? NaN : Number(expRaw)
    if (!sig || !Number.isFinite(parsedExp)) {
      sendPlain(res, 401, 'Unauthorized\n')
      return
    }
    const ok = verifyFileUrl({
      agentId: route.agentId,
      token,
      method: 'GET',
      path: route.relPath,
      sig,
      exp: parsedExp,
    })
    if (!ok) {
      sendPlain(res, 401, 'Unauthorized\n')
      return
    }
    exp = parsedExp
  }
  // token === null: daemon is running without auth (WS also accepts any
  // bearer in this mode — see checkAuth). Skip HMAC entirely so the two
  // surfaces stay consistent.

  let absolutePath: string
  try {
    absolutePath = await assertPathAllowed(runtimeRoot, route.relPath, { allowMissing: false })
  } catch {
    sendPlain(res, 404, 'Not Found\n')
    return
  }

  let info
  try {
    info = await stat(absolutePath)
  } catch {
    sendPlain(res, 404, 'Not Found\n')
    return
  }
  if (!info.isFile()) {
    sendPlain(res, 404, 'Not Found\n')
    return
  }

  const size = info.size
  const mtimeMs = info.mtimeMs
  const etag = `W/"${size}-${Math.floor(mtimeMs)}"`
  const defaultMaxAgeSec = Math.floor(DEFAULT_SIGNED_URL_TTL_MS / 1000)
  const maxAgeSec = exp === null
    ? defaultMaxAgeSec
    : Math.max(0, exp - Math.floor(Date.now() / 1000))

  res.setHeader('content-type', mimeFromPath(absolutePath))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', `private, max-age=${maxAgeSec}`)
  res.setHeader('etag', etag)
  res.setHeader('last-modified', new Date(mtimeMs).toUTCString())
  res.setHeader('x-content-type-options', 'nosniff')

  const range = parseRangeHeader(req.headers['range'], size)
  if (range === 'invalid') {
    res.setHeader('content-range', `bytes */${size}`)
    sendPlain(res, 416, 'Range Not Satisfiable\n')
    return
  }

  const start = range ? range.start : 0
  const end = range ? range.end : (size === 0 ? 0 : size - 1)
  const length = size === 0 ? 0 : end - start + 1
  res.setHeader('content-length', String(length))
  if (range) {
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
    res.writeHead(206)
  } else {
    res.writeHead(200)
  }

  if (req.method === 'HEAD' || length === 0) {
    res.end()
    return
  }

  const stream = createReadStream(absolutePath, { start, end })
  stream.on('error', (err) => {
    console.warn('agentwfy-server: file stream failed:', err)
    if (!res.headersSent) {
      sendPlain(res, 500, 'Failed to stream file\n')
    } else {
      res.destroy(err)
    }
  })
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })
  stream.pipe(res)
}

function parseRangeHeader(
  header: string | string[] | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  if (!value.startsWith('bytes=')) return 'invalid'
  const m = value.slice('bytes='.length).match(/^(\d*)-(\d*)$/)
  if (!m) return 'invalid'
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return 'invalid'
  if (size === 0) return 'invalid'
  let start: number
  let end: number
  if (hasStart) {
    start = parseInt(m[1], 10)
    end = hasEnd ? parseInt(m[2], 10) : size - 1
  } else {
    // Suffix range: bytes=-N → last N bytes.
    const suffix = parseInt(m[2], 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start < 0 || end < start || start >= size) return 'invalid'
  if (end >= size) end = size - 1
  return { start, end }
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
      console.warn('agentwfy-server: snapshot stream failed:', err)
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
    console.warn('agentwfy-server: snapshot failed:', err)
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

  console.log(`agentwfy-server: starting (protocol ${PROTOCOL_VERSION})`)
  console.log(`  agent root: ${runtimeRoot}`)
  console.log(`  auth: ${token ? 'token required' : 'DISABLED (no token configured)'}`)
  if (!token) {
    console.warn('  warning: anyone reachable can issue commands. Run `init` or set AGENTWFY_REMOTE_TOKEN.')
  }

  const bundle = await createAgentRuntime(runtimeRoot, clientBridge)
  console.log(`  runtime: ready (id=${bundle.backend.id})`)

  const handler = makeHttpHandler(bundle, runtimeRoot, token)
  const certPath = process.env['AGENTWFY_REMOTE_TLS_CERT']
  const keyPath = process.env['AGENTWFY_REMOTE_TLS_KEY']
  if ((certPath && !keyPath) || (!certPath && keyPath)) {
    console.error('agentwfy-server: AGENTWFY_REMOTE_TLS_CERT and AGENTWFY_REMOTE_TLS_KEY must both be set')
    process.exit(1)
  }
  const tlsEnabled = Boolean(certPath && keyPath)
  const server = tlsEnabled
    ? createHttpsServer({ cert: readFileSync(certPath!), key: readFileSync(keyPath!) }, handler)
    : createHttpServer(handler)
  server.on('upgrade', (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    handleWebSocket(req, socket as Socket, head, bundle, token, clientBridge)
  })
  server.on('error', (err) => {
    console.error('agentwfy-server: server error:', err)
    process.exitCode = 1
  })

  const shutdown = async (signal: string) => {
    console.log(`agentwfy-server: received ${signal}, shutting down`)
    server.close()
    clientBridge.detach(new Error('Server shutting down'))
    await bundle.dispose().catch((err) => console.warn('dispose failed:', err))
    setTimeout(() => process.exit(0), 100).unref()
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  const host = process.env['AGENTWFY_REMOTE_HOST'] || '127.0.0.1'
  const scheme = tlsEnabled ? 'wss' : 'ws'
  server.listen(port, host, () => {
    console.log(`agentwfy-server: listening on ${scheme}://${host}:${port}${WS_PATH}`)
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
  console.error('agentwfy-server: fatal:', err)
  process.exit(1)
})
