import fs from 'fs/promises'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels } from './channels.cjs'
import { getOrCreateTraceWriter } from './exec-js.js'
import { isValidTraceSessionId, type TraceEvent } from '../runtime/trace_types.js'

export interface TracesApiForSender {
  agentRoot: string
}

async function readTraceFile(filePath: string): Promise<TraceEvent[]> {
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

export function registerTraceHandlers(
  getAgentRoot: (e: IpcMainInvokeEvent) => string,
): void {
  ipcMain.handle(Channels.traces.list, async (event, sessionId?: string) => {
    if (typeof sessionId !== 'string' || !isValidTraceSessionId(sessionId)) return []
    const agentRoot = getAgentRoot(event)
    const writer = getOrCreateTraceWriter(agentRoot)
    await writer.flush(sessionId)
    const filePath = writer.filePathFor(sessionId)
    if (!filePath) return []
    return readTraceFile(filePath)
  })
}
