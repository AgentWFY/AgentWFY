import fs from 'fs/promises'
import path from 'path'
import { isValidTraceSessionId, type TraceEvent } from './trace_types.js'

function safeSessionFileName(sessionId: string): string | null {
  return isValidTraceSessionId(sessionId) ? sessionId : null
}

export class TraceWriter {
  private readonly tracesDir: string
  private readonly queues = new Map<string, Promise<void>>()
  private dirReady: Promise<void> | null = null

  constructor(tracesDir: string) {
    this.tracesDir = tracesDir
  }

  append(event: TraceEvent): void {
    const sessionId = event.sessionId
    const safeName = safeSessionFileName(sessionId)
    if (!safeName) return

    const line = JSON.stringify(event) + '\n'
    const fileName = safeName + '.jsonl'
    const filePath = path.join(this.tracesDir, fileName)

    const prev = this.queues.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(() => this.ensureDir())
      .then(() => fs.appendFile(filePath, line, 'utf-8'))
      .catch((err) => {
        console.error('[trace] append failed:', err)
      })

    this.queues.set(sessionId, next)
  }

  async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      const q = this.queues.get(sessionId)
      if (q) await q
      return
    }
    const all = Array.from(this.queues.values())
    await Promise.allSettled(all)
  }

  getTracesDir(): string {
    return this.tracesDir
  }

  filePathFor(sessionId: string): string | null {
    const safe = safeSessionFileName(sessionId)
    return safe ? path.join(this.tracesDir, safe + '.jsonl') : null
  }

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = fs.mkdir(this.tracesDir, { recursive: true }).then(() => undefined)
    }
    return this.dirReady
  }
}
