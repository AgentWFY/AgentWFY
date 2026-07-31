import type { FileStore } from '../storage/file-store.js'
import { TRACES_RELATIVE_DIR } from './trace_paths.js'
import { isValidTraceSessionId, type TraceEvent } from './trace_types.js'

function safeSessionFileName(sessionId: string): string | null {
  return isValidTraceSessionId(sessionId) ? sessionId : null
}

/**
 * How long records sit in memory before being written. A host call can trace in
 * well under a millisecond, and each write costs a path resolve, a recursive
 * mkdir and an append — three syscalls plus a promise chain hop, per call, per
 * session. Batching turns a burst into one append; the window is short enough
 * that a reader calling `flush()` first (the traces API does) sees no lag.
 */
const FLUSH_INTERVAL_MS = 50

export class TraceWriter {
  private readonly store: FileStore
  /** Per-session tail of in-flight appends, so writes stay ordered. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Serialized records not yet handed to the store, per session. */
  private readonly pending = new Map<string, string[]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(store: FileStore) {
    this.store = store
  }

  append(event: TraceEvent): void {
    const sessionId = event.sessionId
    const safeName = safeSessionFileName(sessionId)
    if (!safeName) return

    const line = JSON.stringify(event) + '\n'
    const buffered = this.pending.get(sessionId)
    if (buffered) {
      buffered.push(line)
    } else {
      this.pending.set(sessionId, [line])
    }

    if (this.flushTimer === null) {
      const timer = setTimeout(() => {
        this.flushTimer = null
        this.drainPending()
      }, FLUSH_INTERVAL_MS)
      // Buffered traces must never hold a shutting-down process open.
      ;(timer as { unref?: () => void }).unref?.()
      this.flushTimer = timer
    }
  }

  async flush(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.drainSession(sessionId)
      const q = this.queues.get(sessionId)
      if (q) await q
      return
    }
    this.drainPending()
    await Promise.allSettled(Array.from(this.queues.values()))
  }

  private drainPending(): void {
    for (const sessionId of Array.from(this.pending.keys())) {
      this.drainSession(sessionId)
    }
  }

  /** Move a session's buffered records onto its append queue. Synchronous, so
   *  callers that then await the queue can't race a still-buffered record. */
  private drainSession(sessionId: string): void {
    const lines = this.pending.get(sessionId)
    if (!lines || lines.length === 0) return
    this.pending.delete(sessionId)

    const safeName = safeSessionFileName(sessionId)
    if (!safeName) return
    const key = `${TRACES_RELATIVE_DIR}/${safeName}.jsonl`
    const text = lines.join('')

    const prev = this.queues.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(() => this.store.appendText(key, text, { allowPrivate: true }))
      .catch((err) => {
        console.error('[trace] append failed:', err)
      })

    this.queues.set(sessionId, next)
  }
}
