import fs from 'fs/promises'
import { isValidTraceSessionId, type TraceEvent } from '../runtime/trace_types.js'
import { getTraceFilePath } from '../runtime/trace_paths.js'

export async function readTraceEvents(filePath: string): Promise<TraceEvent[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

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

export async function listAgentTraces(runtimeRoot: string, sessionId: string): Promise<TraceEvent[]> {
  if (!isValidTraceSessionId(sessionId)) return []
  const filePath = getTraceFilePath(runtimeRoot, sessionId)
  return filePath ? readTraceEvents(filePath) : []
}
