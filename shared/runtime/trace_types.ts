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

// Thrown (and caught) internally by stringifyCapped to abandon the walk.
const OVER_CAP = Symbol('trace.overCap')

/**
 * `stringifySafe` + `truncateWithFlag` in one pass, stopping the walk as soon
 * as `cap` characters have been produced.
 *
 * Serializing first and truncating after means a `read` of a large file or a
 * `runSql` returning thousands of rows is fully JSON-serialized on the main
 * thread just to yield a few KB of preview. Every host call pays that, so it
 * has to be bounded by the cap rather than by the value.
 *
 * Output matches `JSON.stringify` for plain JSON data and honours `toJSON`.
 * Where `JSON.stringify` throws — bigint, cycles — this renders a preview
 * instead, which is what a trace wants; it only falls back to `String(value)`
 * when the walk itself throws (a getter, a hostile proxy).
 */
export function stringifyCapped(value: unknown, cap: number): { text: string; truncated: boolean } {
  if (typeof value === 'string') return truncateWithFlag(value, cap)
  // Match stringifySafe: JSON.stringify yields the value undefined for these.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return truncateWithFlag(String(value), cap)
  }

  const chunks: string[] = []
  let len = 0
  // Ancestors of the value being written, so repeated (but acyclic) references
  // still serialize — only a true cycle is cut, same as JSON.stringify.
  const path: unknown[] = []

  const emit = (text: string): void => {
    chunks.push(text)
    len += text.length
    if (len > cap) throw OVER_CAP
  }

  const emitString = (text: string): void => {
    // Escaping only ever grows the text, so slicing to the remaining budget is
    // already enough to trip the cap — no need to escape megabytes to find out.
    const room = cap - len
    emit(JSON.stringify(text.length > room ? text.slice(0, room + 1) : text))
  }

  const emitValue = (v: unknown): void => {
    if (v === null) return emit('null')
    switch (typeof v) {
      case 'string': return emitString(v)
      case 'number': return emit(Number.isFinite(v) ? String(v) : 'null')
      case 'boolean': return emit(v ? 'true' : 'false')
      case 'bigint': return emit(String(v))
      case 'undefined':
      case 'function':
      case 'symbol': return emit('null') // reachable only from an array slot
    }

    if (path.includes(v)) return emit('"[Circular]"')

    const obj = v as Record<string, unknown> & { toJSON?: () => unknown }
    path.push(v)
    try {
      if (typeof obj.toJSON === 'function') {
        emitValue(obj.toJSON())
      } else if (obj instanceof String) {
        // Boxed primitives serialize as the primitive, same as JSON.stringify.
        emitString(String(obj))
      } else if (obj instanceof Number) {
        const n = Number(obj)
        emit(Number.isFinite(n) ? String(n) : 'null')
      } else if (obj instanceof Boolean) {
        emit(obj.valueOf() ? 'true' : 'false')
      } else if (Array.isArray(v)) {
        emit('[')
        for (let i = 0; i < v.length; i++) {
          if (i > 0) emit(',')
          emitValue(v[i])
        }
        emit(']')
      } else {
        emit('{')
        let first = true
        for (const key of Object.keys(obj)) {
          const child = obj[key]
          const t = typeof child
          if (child === undefined || t === 'function' || t === 'symbol') continue
          if (!first) emit(',')
          first = false
          emitString(key)
          emit(':')
          emitValue(child)
        }
        emit('}')
      }
    } finally {
      path.pop()
    }
  }

  try {
    emitValue(value)
  } catch (err) {
    if (err === OVER_CAP) return { text: chunks.join('').slice(0, cap), truncated: true }
    return truncateWithFlag(String(value), cap)
  }
  return { text: chunks.join(''), truncated: false }
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
