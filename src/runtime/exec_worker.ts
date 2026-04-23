import type {
  ExecJsCapturedFile,
  ExecJsDetails,
  ExecJsSerializedError,
  ExecJsLogEntry,
  HostToWorkerMessage,
  WorkerHostMethodMap,
  WorkerToHostMessage,
  WorkerExecuteRequestMessage,
  WorkerHostResultMessage,
} from './types.js'
import { formatTimeoutError } from './timeout_utils.js'

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

type PendingHostCall = {
  requestId: string
  method: string
  startedAt: number
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const parentPort = process.parentPort!

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>

const pendingHostCalls = new Map<string, PendingHostCall>()
const activeRequests = new Map<string, AbortController>()
const watchedRequests = new Set<string>()
const requestLogs = new Map<string, ExecJsLogEntry[]>()

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...<truncated ${text.length - maxChars} chars>`
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// AsyncFunction adds 2 implicit lines (function signature) + our body wrapper adds 2
// lines: `"use strict";\n` followed by either `return (\n` (expression form) or
// `return await (async () => {\n` (body form). Both prefixes are 2 lines, so a single
// offset works for either compilation path.
const V8_LINE_OFFSET = 4

function cleanStack(raw: string | undefined, codeLineCount?: number): string | undefined {
  if (!raw) return undefined

  const frames: string[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/<anonymous>:(\d+):(\d+)/)
    if (!m) continue
    const userLine = parseInt(m[1], 10) - V8_LINE_OFFSET
    if (userLine < 1) continue
    if (codeLineCount !== undefined && userLine > codeLineCount) continue
    const entry = `  at line ${userLine}, col ${m[2]}`
    if (frames.length === 0 || frames[frames.length - 1] !== entry) {
      frames.push(entry)
    }
  }

  return frames.length > 0 ? frames.join('\n') : undefined
}

function serializeError(error: unknown, codeLineCount?: number): ExecJsSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: cleanStack(error.stack, codeLineCount),
    }
  }

  return {
    name: 'Error',
    message: stringifyUnknown(error),
  }
}

function toError(serialized: ExecJsSerializedError | undefined): Error {
  const message = serialized?.message || 'Worker host call failed'
  const error = new Error(message)
  error.name = serialized?.name || 'Error'
  if (serialized?.stack) {
    error.stack = serialized.stack
  }
  return error
}

function captureConsole(requestId: string): { logs: ExecJsLogEntry[]; restore: () => void } {
  const methods: ConsoleMethod[] = ['debug', 'log', 'info', 'warn', 'error']
  const logs: ExecJsLogEntry[] = []
  requestLogs.set(requestId, logs)
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>()

  methods.forEach((method) => {
    const original = console[method].bind(console)
    originals.set(method, original)

    console[method] = (...args: unknown[]) => {
      const entry: ExecJsLogEntry = {
        level: method,
        message: truncate(args.map((arg) => stringifyUnknown(arg)).join(' '), 5000),
        timestamp: Date.now(),
      }
      logs.push(entry)
      if (watchedRequests.has(requestId)) {
        postToHost({ type: 'exec:log', requestId, logEntry: entry })
      }
    }
  })

  return {
    logs,
    restore: () => {
      methods.forEach((method) => {
        const original = originals.get(method)
        if (original) {
          console[method] = original
        }
      })
      requestLogs.delete(requestId)
      watchedRequests.delete(requestId)
    },
  }
}

const MAX_EXEC_TIMEOUT_MS = 600000

function summarizeInFlightHostCalls(requestId: string, now: number): string {
  const entries: Array<{ method: string; elapsedMs: number }> = []
  for (const pending of pendingHostCalls.values()) {
    if (pending.requestId !== requestId) continue
    entries.push({ method: pending.method, elapsedMs: now - pending.startedAt })
  }
  if (entries.length === 0) return ''
  entries.sort((a, b) => b.elapsedMs - a.elapsedMs)
  const top = entries.slice(0, 3).map((e) => `${e.method} (${e.elapsedMs}ms)`).join(', ')
  const more = entries.length > 3 ? ` (+${entries.length - 3} more)` : ''
  const noun = entries.length === 1 ? 'call' : 'calls'
  return `At timeout: ${entries.length} in-flight host ${noun} — ${top}${more}.`
}

function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  wasDefault: boolean,
  signal: AbortSignal,
  requestId: string,
): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const timerId = setTimeout(() => {
      const base = formatTimeoutError('execJs', timeoutMs, wasDefault, MAX_EXEC_TIMEOUT_MS)
      const inFlight = summarizeInFlightHostCalls(requestId, Date.now())
      reject(new Error(inFlight ? `${base} ${inFlight}` : base))
    }, timeoutMs)

    promise.finally(() => clearTimeout(timerId)).catch(() => {})
  })

  const abortPromise = new Promise<T>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('JavaScript execution aborted'))
      return
    }

    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('JavaScript execution aborted'))
      },
      { once: true }
    )
  })

  return Promise.race([promise, timeoutPromise, abortPromise])
}

function postToHost(message: WorkerToHostMessage): void {
  parentPort.postMessage(message)
}

function rejectPendingCallsForRequest(requestId: string, error: Error): void {
  for (const [callId, pending] of pendingHostCalls) {
    if (pending.requestId !== requestId) {
      continue
    }

    pendingHostCalls.delete(callId)
    pending.reject(error)
  }
}

function handleHostResult(message: WorkerHostResultMessage): void {
  const pending = pendingHostCalls.get(message.callId)
  if (!pending || pending.requestId !== message.requestId) {
    return
  }

  pendingHostCalls.delete(message.callId)

  if (message.ok) {
    pending.resolve(message.value)
    return
  }

  pending.reject(toError(message.error))
}

function callHostMethod(
  requestId: string,
  method: string,
  params: unknown,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new Error('JavaScript execution aborted'))
  }

  const callId = createId('host-call')

  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => {
      if (!pendingHostCalls.delete(callId)) {
        return
      }
      reject(new Error('JavaScript execution aborted'))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    pendingHostCalls.set(callId, {
      requestId,
      method,
      startedAt: Date.now(),
      resolve: (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      reject: (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    })

    postToHost({
      type: 'host:call',
      requestId,
      callId,
      method,
      params,
    })
  })
}

async function executeRequest(message: WorkerExecuteRequestMessage): Promise<void> {
  const { requestId, code, timeoutMs, timeoutWasDefault, input, methods } = message
  const abortController = new AbortController()
  activeRequests.set(requestId, abortController)

  const { logs, restore } = captureConsole(requestId)
  const capturedFiles: ExecJsCapturedFile[] = []

  try {
    const signal = abortController.signal

    const call = (method: string, params: unknown) =>
      callHostMethod('' + requestId, method, params, signal)

    // Shadow browser/Node globals
    const shadowParamNames = [
      'window', 'self', 'globalThis', 'document',
      'require', 'global', 'module', '__filename', '__dirname', 'process',
    ]
    const shadowArgValues: unknown[] = Array(shadowParamNames.length).fill(undefined)

    // Build method bindings from the methods list
    const methodParamNames: string[] = []
    const methodArgValues: Function[] = []
    const pendingAttachments: Promise<unknown>[] = []

    const makeAttachmentBinding = <T extends { base64: string; mimeType: string }>(
      methodName: string,
      toReturnValue: (result: T) => unknown,
    ) => (params: unknown) => {
      const p = (async () => {
        const result = await call(methodName, params) as T
        capturedFiles.push({ base64: result.base64, mimeType: result.mimeType })
        return toReturnValue(result)
      })()
      pendingAttachments.push(p)
      return p
    }

    for (const method of methods) {
      methodParamNames.push(method)

      if (method === 'captureTab') {
        methodArgValues.push(makeAttachmentBinding<WorkerHostMethodMap['captureTab']['result']>(
          'captureTab',
          (r) => ({ attached: true, mimeType: r.mimeType }),
        ))
      } else if (method === 'read') {
        methodArgValues.push((params: unknown) => {
          const req = params as WorkerHostMethodMap['read']['params']
          const p = (async () => {
            const result = await call('read', params)
            if (result && typeof result === 'object' && 'base64' in (result as Record<string, unknown>)) {
              const binResult = result as { base64: string; mimeType: string; size: number }
              if (req && req.asBase64) {
                return binResult
              }
              capturedFiles.push({ base64: binResult.base64, mimeType: binResult.mimeType })
              return { attached: true, mimeType: binResult.mimeType, size: binResult.size }
            }
            return result
          })()
          pendingAttachments.push(p)
          return p
        })
      } else {
        methodArgValues.push((params: unknown) => call(method, params))
      }
    }

    // Try compiling as a bare expression first so agents can write
    // `await read({ path })` instead of `const x = await read({ path }); return x;`.
    // If the expression wrap is a SyntaxError — e.g. code has statements, declarations,
    // or its own `return` — fall back to the original async IIFE body.
    const expressionBody = `"use strict";\nreturn (\n${code}\n);`
    const iifeBody = `"use strict";\nreturn await (async () => {\n${code}\n})();`

    let fn: (...callArgs: unknown[]) => Promise<unknown>
    try {
      fn = new AsyncFunction(
        ...shadowParamNames,
        ...methodParamNames,
        'input',
        expressionBody,
      )
    } catch (compileErr) {
      if (!(compileErr instanceof SyntaxError)) throw compileErr
      fn = new AsyncFunction(
        ...shadowParamNames,
        ...methodParamNames,
        'input',
        iifeBody,
      )
    }

    const value = await withTimeoutAndAbort(
      fn(
        ...shadowArgValues,
        ...methodArgValues,
        input,
      ),
      timeoutMs,
      timeoutWasDefault,
      abortController.signal,
      requestId,
    )

    await Promise.allSettled(pendingAttachments)

    const details: ExecJsDetails = {
      ok: true,
      value,
      logs,
      files: capturedFiles,
      timeoutMs,
    }

    postToHost({
      type: 'exec:result',
      requestId,
      details,
    })
  } catch (error) {
    const details: ExecJsDetails = {
      ok: false,
      error: serializeError(error, code.split('\n').length),
      logs,
      files: capturedFiles,
      timeoutMs,
    }

    postToHost({
      type: 'exec:result',
      requestId,
      details,
    })
  } finally {
    restore()
    activeRequests.delete(requestId)
    rejectPendingCallsForRequest(requestId, new Error('JavaScript execution aborted'))
  }
}

function cancelRequest(requestId: string): void {
  const controller = activeRequests.get(requestId)
  if (!controller) {
    return
  }

  controller.abort()
}

function handleFatalError(error: unknown): void {
  const serialized = serializeError(error)
  // Write to stderr first — piped to host and flushed reliably before exit
  process.stderr.write(`${serialized.stack ?? `${serialized.name}: ${serialized.message}`}\n`)
  // Best-effort IPC — may not be delivered before process exits
  try {
    parentPort.postMessage({ type: 'worker:crash', error: serialized })
  } catch {
    // parentPort may already be unusable
  }
  process.exit(1)
}

process.on('uncaughtException', handleFatalError)
process.on('unhandledRejection', handleFatalError)

parentPort.on('message', (messageEvent: { data: HostToWorkerMessage }) => {
  const message = messageEvent.data
  if (!message || typeof message !== 'object' || typeof (message as unknown as Record<string, unknown>).type !== 'string') {
    return
  }

  switch (message.type) {
    case 'exec:run':
      void executeRequest(message)
      return
    case 'exec:cancel':
      cancelRequest(message.requestId)
      return
    case 'host:result':
      handleHostResult(message)
      return
    case 'exec:watch': {
      const rid = message.requestId
      watchedRequests.add(rid)
      const existing = requestLogs.get(rid)
      if (existing) {
        for (const entry of existing) {
          postToHost({ type: 'exec:log', requestId: rid, logEntry: entry })
        }
      }
      return
    }
    case 'exec:unwatch':
      watchedRequests.delete(message.requestId)
      return
    default:
      return
  }
})
