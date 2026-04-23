export const TRACE_VERSION = 1

export interface TraceErrorInfo {
  name: string
  message: string
}

export interface TraceExecEvent {
  v: 1
  t: 'exec'
  id: string
  sessionId: string
  description: string
  code: string
  codeTruncated: boolean
  startedAt: number
  durationMs: number
  ok: boolean
  error: TraceErrorInfo | null
  resultPreview: string | null
  resultTruncated: boolean
  timeoutMs: number
}

export interface TraceCallEvent {
  v: 1
  t: 'call'
  id: string
  execId: string
  sessionId: string
  method: string
  paramsPreview: string
  paramsTruncated: boolean
  resultPreview: string | null
  resultTruncated: boolean
  startedAt: number
  durationMs: number
  ok: boolean
  error: TraceErrorInfo | null
}

export type TraceEvent = TraceExecEvent | TraceCallEvent

export const TRACE_CODE_CAP = 32_000
export const TRACE_PARAMS_CAP = 16_000
export const TRACE_RESULT_CAP = 4_000

const TRACE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/

export function isValidTraceSessionId(sessionId: string): boolean {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId.length <= 200
    && TRACE_SESSION_ID_RE.test(sessionId)
}

export function stringifySafe(value: unknown): string {
  if (typeof value === 'string') return value
  // JSON.stringify returns the VALUE undefined (not throwing) for undefined /
  // function / symbol inputs, so we must coerce before returning. Without this
  // the caller reads .length on undefined and throws.
  try {
    const s = JSON.stringify(value)
    return typeof s === 'string' ? s : String(value)
  } catch {
    return String(value)
  }
}

export function truncateWithFlag(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  return { text: text.slice(0, cap), truncated: true }
}

export function toTraceError(err: unknown): TraceErrorInfo {
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : stringifySafe(err),
    }
  }
  return { name: 'Error', message: String(err) }
}
