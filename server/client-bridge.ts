import {
  decodeWsMessage,
  encodeWsMessage,
  type ClientFunctionsInvokeResponse,
  type WireError,
  type WsMessage,
  type WsRpcRequest,
} from '#shared/backend/protocol.js'
import type { ClientFunctionInvoker } from '#shared/runtime/client-functions.js'
import type { WsConnection } from './ws.js'

interface PendingClientRpc {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class ConnectedClientBridge implements ClientFunctionInvoker {
  private connection: WsConnection | null = null
  private readonly pending = new Map<string, PendingClientRpc>()
  private nextRpcId = 1

  constructor(private readonly timeoutMs = 120_000) {}

  get isConnected(): boolean {
    return this.connection !== null
  }

  attach(connection: WsConnection): void {
    const previous = this.connection
    this.connection = null
    this.rejectPending(new Error('Client connection replaced'))
    previous?.close(1000, 'connection replaced')
    this.connection = connection
  }

  detach(error = new Error('Client disconnected'), connection?: WsConnection): void {
    if (connection && this.connection !== connection) return
    this.connection = null
    this.rejectPending(error)
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
    const connection = this.connection
    if (!connection) {
      throw new Error(`Client is not connected; function ${name} is not available`)
    }

    const id = `server-${this.nextRpcId++}`
    const req: WsRpcRequest = {
      type: 'rpc',
      id,
      method: 'client.functions.invoke',
      params: { name, params },
    }

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Client function ${name} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      connection.send(encodeWsMessage(req))
    })

    const response = result as ClientFunctionsInvokeResponse
    return response?.value
  }
}

function errorFromWire(error: WireError): Error {
  const err = new Error(error.message)
  err.name = error.name
  return err
}
