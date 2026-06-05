// WsClient — environment-neutral WebSocket transport for the daemon RPC
// protocol. Handles connect/reconnect, an RPC request/response envelope
// (client-side), and exposes raw non-rpc-result messages to a single
// caller-supplied handler. Knows nothing about AgentBackend semantics —
// that's RemoteBackend's job, layered above this client.

import {
  decodeWsMessage,
  encodeWsMessage,
  messageFromUnknown,
  WS_PATH,
  type RpcMethod,
  type WireError,
  type WsMessage,
  type WsRpcRequest,
} from './protocol.js'
import type {
  BackendConnectionState,
  BackendStatusSnapshot,
  StatusApi,
  Unsubscribe,
} from './interface.js'

interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: unknown) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
}

type WebSocketCtor = new (url: string) => WebSocketLike

const WS_OPEN = 1
const DEFAULT_INITIAL_RECONNECT_MS = 500
const DEFAULT_MAX_RECONNECT_MS = 30_000
const DEFAULT_RPC_TIMEOUT_MS = 120_000

export interface WsClientConfig {
  /** HTTP(S) base URL of the daemon, no trailing slash. Converted to ws(s). */
  baseUrl: string
  /** Per-agent auth token issued by the daemon's admin CLI. */
  agentToken: string
  /** Optional WebSocket implementation for tests / nonstandard hosts. */
  webSocketImpl?: WebSocketCtor
  initialReconnectMs?: number
  maxReconnectMs?: number
  rpcTimeoutMs?: number
}

export class WsClientError extends Error {
  readonly code?: string
  constructor(name: string, message: string, code?: string) {
    super(message)
    this.name = name
    if (code !== undefined) this.code = code
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export type WsMessageHandler = (message: WsMessage) => void | Promise<void>

export class WsClient {
  private readonly baseUrl: string
  private readonly agentToken: string
  private readonly WebSocketCtor: WebSocketCtor
  private readonly initialReconnectMs: number
  private readonly maxReconnectMs: number
  private readonly rpcTimeoutMs: number

  private readonly statusSubscribers = new Set<(status: BackendStatusSnapshot) => void>()
  private readonly pending = new Map<string, PendingRpc>()
  private socket: WebSocketLike | null = null
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private statusSnapshot: BackendStatusSnapshot = {
    state: 'disconnected',
    message: 'Remote backend is not connected',
    updatedAt: Date.now(),
  }
  private reconnectAttempt = 0
  private stopped = true
  private nextRpcId = 1
  private messageHandler: WsMessageHandler | null = null

  constructor(config: WsClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.agentToken = config.agentToken
    const ctor = config.webSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
    if (!ctor) {
      throw new WsClientError('WebSocketUnavailable', 'This runtime does not provide WebSocket')
    }
    this.WebSocketCtor = ctor
    this.initialReconnectMs = config.initialReconnectMs ?? DEFAULT_INITIAL_RECONNECT_MS
    this.maxReconnectMs = config.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS
    this.rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  }

  /** Register the handler for incoming non-rpc-result messages (events,
   *  db:changed, server-initiated rpc, hello). Set once. */
  setMessageHandler(handler: WsMessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.reconnectAttempt = 0
    this.setStatus({
      state: 'connecting',
      message: 'Connecting to remote agent...',
      reconnectAttempt: this.reconnectAttempt,
    })
    this.scheduleReconnect(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAllPending(new WsClientError('Disconnected', 'Remote backend stopped'))
    this.socket?.close()
    this.socket = null
    await this.connectPromise?.catch(() => {})
    this.connectPromise = null
    this.setStatus({ state: 'disconnected', message: 'Remote backend stopped' })
    this.statusSubscribers.clear()
  }

  readonly status: StatusApi = {
    get: (): BackendStatusSnapshot => ({ ...this.statusSnapshot }),
    subscribe: (handler: (status: BackendStatusSnapshot) => void): Unsubscribe => {
      this.statusSubscribers.add(handler)
      handler({ ...this.statusSnapshot })
      return () => {
        this.statusSubscribers.delete(handler)
      }
    },
  }

  /** Send an RPC and await its response. Throws on timeout/disconnect. */
  async rpc<Req, Res>(method: RpcMethod, params: Req): Promise<Res> {
    await this.ensureConnected()
    const socket = this.socket
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new WsClientError('Disconnected', 'Remote server is not connected')
    }

    const id = `client-${this.nextRpcId++}`
    const message: WsRpcRequest = { type: 'rpc', id, method, params }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WsClientError('Timeout', `${method} timed out after ${this.rpcTimeoutMs}ms`))
      }, this.rpcTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })

    try {
      socket.send(encodeWsMessage(message))
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
      }
      throw error
    }

    return await promise as Res
  }

  /** Send a raw message — used by callers replying to server-initiated RPCs. */
  send(message: WsMessage): void {
    this.socket?.send(encodeWsMessage(message))
  }

  /** True when the socket is open. */
  get isConnected(): boolean {
    return this.socket?.readyState === WS_OPEN
  }

  private ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WS_OPEN) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private openSocket(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new WsClientError('Disconnected', 'Remote backend is stopped'))
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let opened = false
      this.setStatus({
        state: 'connecting',
        message: 'Connecting to remote agent...',
        reconnectAttempt: this.reconnectAttempt,
      })

      const settleOk = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const settleErr = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }

      let socket: WebSocketLike
      try {
        socket = new this.WebSocketCtor(this.buildWsUrl())
      } catch (err) {
        const message = connectionFailureMessage(this.baseUrl, err)
        this.setStatus({
          state: 'error',
          message,
          reconnectAttempt: this.reconnectAttempt,
        })
        settleErr(new WsClientError('WebSocketError', message))
        return
      }
      this.socket = socket

      socket.addEventListener('open', () => {
        opened = true
        this.reconnectAttempt = 0
        this.setStatus({ state: 'connected', message: 'Remote agent connected' })
        settleOk()
      })
      socket.addEventListener('message', (event) => {
        void this.handleRawMessage(event.data)
      })
      socket.addEventListener('error', (event) => {
        const message = connectionFailureMessage(this.baseUrl, describeWebSocketIssue(event))
        const error = new WsClientError('WebSocketError', message)
        this.setStatus({
          state: 'error',
          message,
          reconnectAttempt: this.reconnectAttempt,
        })
        settleErr(error)
      })
      socket.addEventListener('close', (event) => {
        if (this.socket === socket) this.socket = null
        this.rejectAllPending(new WsClientError('Disconnected', 'Remote server WebSocket closed'))
        if (!settled) {
          const message = connectionFailureMessage(this.baseUrl, describeWebSocketIssue(event))
          this.setStatus({
            state: 'error',
            message,
            reconnectAttempt: this.reconnectAttempt,
          })
          settleErr(new WsClientError('Disconnected', message))
        }
        if (!this.stopped && opened) {
          const issue = normalizeConnectionIssueText(describeWebSocketIssue(event)) ?? 'Connection lost'
          this.setStatus({
            state: 'disconnected',
            message: `${issue}. Reconnecting...`,
            reconnectAttempt: this.reconnectAttempt,
            nextRetryMs: this.initialReconnectMs,
          })
          this.scheduleReconnect(this.initialReconnectMs)
        }
      })
    })
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped || this.reconnectTimer) return
    let delay = delayMs
    const tick = () => {
      this.reconnectTimer = null
      if (this.stopped || this.socket?.readyState === WS_OPEN) return
      this.setStatus({
        state: 'connecting',
        message: 'Connecting to remote agent...',
        reconnectAttempt: this.reconnectAttempt,
      })
      this.ensureConnected()
        .catch((err) => {
          const message = messageFromUnknown(err)
          console.warn('[WsClient] reconnect failed:', message)
          this.reconnectAttempt += 1
          delay = delay === 0 ? this.initialReconnectMs : Math.min(delay * 2, this.maxReconnectMs)
          const failure = stripTrailingPeriod(connectionFailureMessage(this.baseUrl, message))
          this.setStatus({
            state: 'error',
            message: `${failure}. Retrying in ${formatDelay(delay)}.`,
            reconnectAttempt: this.reconnectAttempt,
            nextRetryMs: delay,
          })
          this.scheduleReconnect(delay)
        })
    }
    this.reconnectTimer = setTimeout(tick, delay)
  }

  private buildWsUrl(): string {
    const protocol = this.baseUrl.startsWith('https:') ? 'wss:' : 'ws:'
    const withoutProtocol = this.baseUrl.replace(/^https?:/, '')
    const token = encodeURIComponent(this.agentToken)
    return `${protocol}${withoutProtocol}${WS_PATH}?token=${token}`
  }

  private async handleRawMessage(data: unknown): Promise<void> {
    const raw = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(data)
        : String(data)

    let message: WsMessage
    try {
      message = decodeWsMessage(raw)
    } catch (err) {
      console.warn('[WsClient] dropping malformed WebSocket message:', err)
      return
    }

    // RPC results are handled internally — we own the pending-request map.
    if (message.type === 'rpc:result') {
      this.handleRpcResult(message)
      return
    }
    await this.messageHandler?.(message)
  }

  private handleRpcResult(message: Extract<WsMessage, { type: 'rpc:result' }>): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.value)
    } else {
      pending.reject(new WsClientError(
        message.error.name,
        message.error.message,
        message.error.code,
      ))
    }
  }

  private rejectAllPending(error: unknown): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private setStatus(next: Omit<BackendStatusSnapshot, 'updatedAt'>): void {
    this.statusSnapshot = {
      ...next,
      updatedAt: Date.now(),
    }
    for (const handler of this.statusSubscribers) {
      try {
        handler({ ...this.statusSnapshot })
      } catch (err) {
        console.error('[WsClient] status subscriber threw:', err)
      }
    }
  }
}

export type { BackendConnectionState }

function describeWebSocketIssue(event: unknown): string {
  if (event instanceof Error) return event.message || event.name || 'WebSocket connection failed'
  if (typeof event === 'string' && event && event !== '[object ErrorEvent]') return event
  if (event && typeof event === 'object') {
    const maybe = event as {
      error?: unknown
      message?: unknown
      type?: unknown
      code?: unknown
      reason?: unknown
    }
    if (maybe.error instanceof Error) {
      return maybe.error.message || maybe.error.name || 'WebSocket connection failed'
    }
    if (typeof maybe.error === 'string' && maybe.error) return maybe.error
    if (typeof maybe.message === 'string' && maybe.message) return maybe.message

    const details: string[] = []
    if (typeof maybe.type === 'string' && maybe.type) details.push(maybe.type)
    if (typeof maybe.code === 'number') details.push(`code ${maybe.code}`)
    if (typeof maybe.reason === 'string' && maybe.reason) details.push(maybe.reason)
    if (details.length > 0) return `WebSocket ${details.join(' ')}`
  }
  return 'WebSocket connection failed'
}

function connectionFailureMessage(baseUrl: string, issue: unknown): string {
  const message = typeof issue === 'string' ? issue : messageFromUnknown(issue)
  if (message.startsWith('Cannot reach remote agent at ')) return message

  const detail = normalizeConnectionIssueText(message)
  const prefix = `Cannot reach remote agent at ${baseUrl}`
  if (detail) return `${prefix}: ${detail}`
  return `${prefix}. Check that the daemon is running and the URL/token are correct.`
}

function normalizeConnectionIssueText(message: string): string | null {
  const text = message.trim()
  if (!text) return null

  const lower = text.toLowerCase()
  if (
    lower === 'typeerror'
    || lower === 'error'
    || lower === 'unknown error'
    || lower === 'websocket error'
    || lower === 'websocket connection failed'
    || lower === '[object errorevent]'
    || lower === '[object event]'
  ) {
    return null
  }

  return text
}

function stripTrailingPeriod(message: string): string {
  return message.endsWith('.') ? message.slice(0, -1) : message
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  return `${seconds}s`
}

export type { WireError }
