type WebSocketConstructor = new (url: string) => WebSocketLike

interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open', listener: () => void, options?: { once?: boolean }): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void, options?: { once?: boolean }): void
  addEventListener(type: 'close', listener: () => void, options?: { once?: boolean }): void
}

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export interface CdpEvent {
  method: string
  params: unknown
  sessionId?: string
}

export class CdpClient {
  private readonly ws: WebSocketLike
  private readonly pending = new Map<number, PendingCommand>()
  private readonly eventListeners = new Set<(event: CdpEvent) => void>()
  private nextId = 1
  private closed = false

  private constructor(ws: WebSocketLike) {
    this.ws = ws
    ws.addEventListener('message', (event) => this.handleMessage(event.data))
    ws.addEventListener('close', () => this.closeWithError(new Error('CDP WebSocket closed')), { once: true })
    ws.addEventListener('error', (event) => this.closeWithError(new Error(`CDP WebSocket error: ${String(event)}`)), { once: true })
  }

  static async connect(webSocketDebuggerUrl: string): Promise<CdpClient> {
    const Ws = getWebSocketConstructor()
    const ws = new Ws(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', (event) => reject(new Error(`CDP WebSocket error: ${String(event)}`)), { once: true })
      ws.addEventListener('close', () => reject(new Error('CDP WebSocket closed before open')), { once: true })
    })
    return new CdpClient(ws)
  }

  send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('CDP connection is closed'))
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = {
      id,
      method,
      params: params ?? {},
    }
    if (sessionId) payload.sessionId = sessionId

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  close(): void {
    this.closeWithError(new Error('CDP connection closed'))
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: unknown): void {
    let message: {
      id?: unknown
      result?: unknown
      error?: { message?: string }
      method?: unknown
      params?: unknown
      sessionId?: unknown
    }
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message || 'CDP command failed'))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: message.params,
        sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
      }
      for (const listener of this.eventListeners) {
        try {
          listener(event)
        } catch {
          // observers are isolated
        }
      }
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

function getWebSocketConstructor(): WebSocketConstructor {
  const Ws = (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket
  if (!Ws) {
    throw new Error('WebSocket is not available in this runtime')
  }
  return Ws
}
