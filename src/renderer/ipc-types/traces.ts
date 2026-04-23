import type { TraceEvent } from '../../runtime/trace_types.js'

export type { TraceEvent }
export type { TraceExecEvent, TraceCallEvent } from '../../runtime/trace_types.js'

export interface TracesApi {
  list(sessionId: string): Promise<TraceEvent[]>
}
