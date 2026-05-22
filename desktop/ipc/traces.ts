import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels } from './channels.cjs'
import { isValidTraceSessionId, type TraceEvent } from '#shared/runtime/trace_types.js'
import type { AgentBackend } from '#shared/backend/interface.js'

export function registerTraceHandlers(
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
): void {
  ipcMain.handle(Channels.traces.list, async (event, sessionId?: string): Promise<TraceEvent[]> => {
    if (typeof sessionId !== 'string' || !isValidTraceSessionId(sessionId)) return []
    return getBackend(event).traces.list({ sessionId })
  })
}
