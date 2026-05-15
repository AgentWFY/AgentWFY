import fs from 'fs/promises'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels } from './channels.cjs'
import { getOrCreateTraceWriter } from './exec-js.js'
import { isValidTraceSessionId, type TraceEvent } from '#shared/runtime/trace_types.js'
import type { AgentBackend } from '#shared/backend/interface.js'

export interface TracesApiForSender {
  runtimeRoot: string
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
  getCacheRoot: (e: IpcMainInvokeEvent) => string,
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
): void {
  ipcMain.handle(Channels.traces.list, async (event, sessionId?: string) => {
    if (typeof sessionId !== 'string' || !isValidTraceSessionId(sessionId)) return []
    if (getBackend(event).kind !== 'local') return []
    const runtimeRoot = getCacheRoot(event)
    const writer = getOrCreateTraceWriter(runtimeRoot)
    await writer.flush(sessionId)
    const filePath = writer.filePathFor(sessionId)
    if (!filePath) return []
    return readTraceFile(filePath)
  })
}
