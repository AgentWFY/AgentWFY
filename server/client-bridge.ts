import {
  decodeWsMessage,
  encodeWsMessage,
  type ClientPageRpcMethod,
  type ClientPageRpcRequest,
  type ClientPageRpcResponse,
  type ClientFunctionsInvokeResponse,
  type WireError,
  type WsMessage,
  type WsRpcRequest,
} from '#shared/backend/protocol.js'
import type { ClientPageRpcInvoker } from '#shared/page/remote-client-page-host.js'
import type { ClientFunctionInvoker } from '#shared/runtime/client-functions.js'
import type { WsConnection } from './ws.js'

interface PendingClientRpc {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class ConnectedClientBridge implements ClientFunctionInvoker, ClientPageRpcInvoker {
  private connection: WsConnection | null = null
  private readonly pending = new Map<string, PendingClientRpc>()
  private readonly connectionSubscribers = new Set<(connected: boolean) => void>()
  private nextRpcId = 1

  constructor(private readonly timeoutMs = 120_000) {}

  get isConnected(): boolean {
    return this.connection !== null
  }

  get isPageClientConnected(): boolean {
    return this.isConnected
  }

  onPageClientConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionSubscribers.add(handler)
    handler(this.isConnected)
    return () => {
      this.connectionSubscribers.delete(handler)
    }
  }

  attach(connection: WsConnection): void {
    const previous = this.connection
    this.connection = null
    this.rejectPending(new Error('Client connection replaced'))
    previous?.close(1000, 'connection replaced')
    this.connection = connection
    this.emitConnectionChanged()
  }

  detach(error = new Error('Client disconnected'), connection?: WsConnection): void {
    if (connection && this.connection !== connection) return
    this.connection = null
    this.rejectPending(error)
    this.emitConnectionChanged()
  }

  private rejectPending(error: unknown): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  handleTextMessage(raw: string): WsMessage | null {
    const message = decodeWsMessage(raw)
    if (message.type !== 'rpc:result') return message

    const pending = this.pending.get(message.id)
    if (!pending) return null
    clearTimeout(pending.timer)
    this.pending.delete(message.id)

    if (message.ok) {
      pending.resolve(message.value)
    } else {
      pending.reject(errorFromWire(message.error))
    }
    return null
  }

  async invokeClientFunction(name: string, params: unknown): Promise<unknown> {
    const result = await this.invokeClientRpc('client.functions.invoke', { name, params }, `function ${name}`)
    const response = result as ClientFunctionsInvokeResponse
    return response?.value
  }

  async invokeClientPageRpc<M extends ClientPageRpcMethod>(
    method: M,
    params: ClientPageRpcRequest<M>,
  ): Promise<ClientPageRpcResponse<M>> {
    return this.invokeClientRpc(method, params, method) as Promise<ClientPageRpcResponse<M>>
  }

  private async invokeClientRpc(method: WsRpcRequest['method'], params: unknown, label: string): Promise<unknown> {
    const connection = this.connection
    if (!connection) {
      throw new Error(`Client is not connected; ${label} is not available`)
    }

    const id = `server-${this.nextRpcId++}`
    const req: WsRpcRequest = {
      type: 'rpc',
      id,
      method,
      params,
    }

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Client RPC ${label} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      connection.send(encodeWsMessage(req))
    })

    return result
  }

  private emitConnectionChanged(): void {
    const connected = this.isConnected
    for (const handler of this.connectionSubscribers) {
      try {
        handler(connected)
      } catch (err) {
        console.warn('[client-bridge] connection subscriber failed:', err)
      }
    }
  }
}

function errorFromWire(error: WireError): Error {
  const err = new Error(error.message)
  err.name = error.name
  return err
}
