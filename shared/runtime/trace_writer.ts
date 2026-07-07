import type { FileStore } from '../storage/file-store.js'
import { TRACES_RELATIVE_DIR } from './trace_paths.js'
import { isValidTraceSessionId, type TraceEvent } from './trace_types.js'

function safeSessionFileName(sessionId: string): string | null {
  return isValidTraceSessionId(sessionId) ? sessionId : null
}

export class TraceWriter {
  private readonly store: FileStore
  private readonly queues = new Map<string, Promise<void>>()

  constructor(store: FileStore) {
    this.store = store
  }

  append(event: TraceEvent): void {
    const sessionId = event.sessionId
    const safeName = safeSessionFileName(sessionId)
    if (!safeName) return

    const line = JSON.stringify(event) + '\n'
    const key = `${TRACES_RELATIVE_DIR}/${safeName}.jsonl`

    const prev = this.queues.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(() => this.store.appendText(key, line, { allowPrivate: true }))
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
}
