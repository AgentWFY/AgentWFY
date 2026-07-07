import { isValidTraceSessionId, type TraceEvent } from '../runtime/trace_types.js'
import { TRACES_RELATIVE_DIR } from '../runtime/trace_paths.js'
import type { FileStore } from '../storage/file-store.js'

function parseTraceEvents(raw: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as TraceEvent
      if (parsed && typeof parsed === 'object' && (parsed.t === 'exec' || parsed.t === 'call')) {
        events.push(parsed)
      }
    } catch {
      // Skip malformed line — likely a partial write in progress.
    }
  }
  return events
}

export async function listAgentTraces(store: FileStore, sessionId: string): Promise<TraceEvent[]> {
  if (!isValidTraceSessionId(sessionId)) return []
  let raw: string
  try {
    raw = await store.readText(`${TRACES_RELATIVE_DIR}/${sessionId}.jsonl`, { allowPrivate: true })
  } catch {
    // Missing or unreadable trace file — nothing to show.
    return []
  }
  return parseTraceEvents(raw)
}
