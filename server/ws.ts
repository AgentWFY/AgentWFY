import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsConnection {
  send(text: string): void
  close(code?: number, reason?: string): void
}

export interface WsConnectionHandlers {
  onMessage(text: string): void
  onClose(): void
  onError(error: Error): void
}

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return req.headers.upgrade?.toLowerCase() === 'websocket'
}

export function acceptWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  handlers: WsConnectionHandlers,
): WsConnection {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || key.length === 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    throw new Error('Missing Sec-WebSocket-Key')
  }

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n',
  )

  let buffer = Buffer.alloc(0)
  let closed = false
  let closeNotified = false

  const connection: WsConnection = {
    send(text: string): void {
      if (closed || socket.destroyed) return
      socket.write(encodeTextFrame(text))
    },
    close(code = 1000, reason = ''): void {
      if (closed) return
      closed = true
      socket.write(encodeCloseFrame(code, reason), () => socket.end())
    },
  }

  const cleanup = () => {
    if (closeNotified) return
    closeNotified = true
    closed = true
    handlers.onClose()
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    try {
      while (buffer.length > 0) {
        const parsed = tryReadFrame(buffer)
        if (!parsed) break
        buffer = buffer.subarray(parsed.bytes)
        if (parsed.opcode === 0x1) {
          handlers.onMessage(parsed.payload.toString('utf-8'))
        } else if (parsed.opcode === 0x8) {
          cleanup()
          socket.end()
          return
        } else if (parsed.opcode === 0x9) {
          if (!closed && !socket.destroyed) socket.write(encodeFrame(0xA, parsed.payload))
        }
      }
    } catch (err) {
      handlers.onError(err instanceof Error ? err : new Error(String(err)))
      connection.close(1002, 'protocol error')
    }
  })
  socket.on('close', cleanup)
  socket.on('error', (err) => {
    handlers.onError(err)
    cleanup()
  })

  if (head.length > 0) {
    queueMicrotask(() => socket.emit('data', head))
  }

  return connection
}

function tryReadFrame(buffer: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  if (buffer.length < 2) return null

  const b0 = buffer[0]
  const b1 = buffer[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let payloadLength = b1 & 0x7f
  let offset = 2

  if (!fin) throw new Error('Fragmented WebSocket frames are not supported')
  if (!masked) throw new Error('Client WebSocket frames must be masked')

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null
    payloadLength = buffer.readUInt16BE(offset)
    offset += 2
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null
    const big = buffer.readBigUInt64BE(offset)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large')
    payloadLength = Number(big)
    offset += 8
  }

  if (buffer.length < offset + 4 + payloadLength) return null
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength))
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= mask[i % 4]
  }

  return { opcode, payload, bytes: offset + payloadLength }
}

function encodeTextFrame(text: string): Buffer {
  return encodeFrame(0x1, Buffer.from(text, 'utf-8'))
}

function encodeCloseFrame(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf-8')
  const payload = Buffer.alloc(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  return encodeFrame(0x8, payload)
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}
