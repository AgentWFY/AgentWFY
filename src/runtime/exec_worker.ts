import type {
  ExecJsCapturedImage,
  ExecJsDetails,
  ExecJsSerializedError,
  ExecJsLogEntry,
  HostToWorkerMessage,
  WorkerHostMethodMap,
  WorkerToHostMessage,
  WorkerExecuteRequestMessage,
  WorkerHostResultMessage,
} from './types.js'

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

type PendingHostCall = {
  requestId: string
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

function serializeError(error: unknown): ExecJsSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
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
      original(...args)
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

function withTimeoutAndAbort<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const timerId = setTimeout(() => {
      reject(new Error(`JavaScript execution timed out after ${timeoutMs}ms`))
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

// Built-in wrappers provide ergonomic signatures for known host methods.
// Each entry maps a host method name to an exposed name and wrapper factory.
interface BuiltInWrapper {
  exposedName: string
  create: (call: (method: string, params: unknown) => Promise<unknown>, capturedImages: ExecJsCapturedImage[]) => Function
}

const builtInWrappers: Record<string, BuiltInWrapper> = {
  runSql: {
    exposedName: 'runSql',
    create: (call) => (request: WorkerHostMethodMap['runSql']['params']) =>
      call('runSql', request),
  },
  read: {
    exposedName: 'read',
    create: (call) => (path: string, offset?: number, limit?: number) =>
      call('read', { path, offset, limit }),
  },
  write: {
    exposedName: 'write',
    create: (call) => (path: string, content: string) =>
      call('write', { path, content }),
  },
  writeBinary: {
    exposedName: 'writeBinary',
    create: (call) => (path: string, base64: string) =>
      call('writeBinary', { path, base64 }),
  },
  edit: {
    exposedName: 'edit',
    create: (call) => (path: string, oldText: string, newText: string) =>
      call('edit', { path, oldText, newText }),
  },
  ls: {
    exposedName: 'ls',
    create: (call) => (path?: string, limit?: number) =>
      call('ls', { path, limit }),
  },
  mkdir: {
    exposedName: 'mkdir',
    create: (call) => (path: string, recursive?: boolean) =>
      call('mkdir', { path, recursive }),
  },
  remove: {
    exposedName: 'remove',
    create: (call) => (path: string, recursive?: boolean) =>
      call('remove', { path, recursive }),
  },
  find: {
    exposedName: 'find',
    create: (call) => (pattern: string, path?: string, limit?: number) =>
      call('find', { pattern, path, limit }),
  },
  grep: {
    exposedName: 'grep',
    create: (call) => (pattern: string, path?: string, options?: WorkerHostMethodMap['grep']['params']['options']) =>
      call('grep', { pattern, path, options }),
  },
  getTabs: {
    exposedName: 'getTabs',
    create: (call) => () =>
      call('getTabs', {}),
  },
  openTab: {
    exposedName: 'openTab',
    create: (call) => (request: WorkerHostMethodMap['openTab']['params']) =>
      call('openTab', request),
  },
  closeTab: {
    exposedName: 'closeTab',
    create: (call) => (request: WorkerHostMethodMap['closeTab']['params']) =>
      call('closeTab', request),
  },
  selectTab: {
    exposedName: 'selectTab',
    create: (call) => (request: WorkerHostMethodMap['selectTab']['params']) =>
      call('selectTab', request),
  },
  reloadTab: {
    exposedName: 'reloadTab',
    create: (call) => (request: WorkerHostMethodMap['reloadTab']['params']) =>
      call('reloadTab', request),
  },
  captureTab: {
    exposedName: 'captureTab',
    create: (call, capturedImages) => async (request: WorkerHostMethodMap['captureTab']['params']) => {
      const result = await call('captureTab', request) as WorkerHostMethodMap['captureTab']['result']
      capturedImages.push({ base64: result.base64, mimeType: result.mimeType })
      return { captured: true, mimeType: result.mimeType }
    },
  },
  getTabConsoleLogs: {
    exposedName: 'getTabConsoleLogs',
    create: (call) => (request: WorkerHostMethodMap['getTabConsoleLogs']['params']) =>
      call('getTabConsoleLogs', request),
  },
  execTabJs: {
    exposedName: 'execTabJs',
    create: (call) => (request: WorkerHostMethodMap['execTabJs']['params']) =>
      call('execTabJs', request),
  },
  busPublish: {
    exposedName: 'publish',
    create: (call) => (topic: string, data: unknown) =>
      call('busPublish', { topic, data }),
  },
  busWaitFor: {
    exposedName: 'waitFor',
    create: (call) => (topic: string, timeoutMs?: number) =>
      call('busWaitFor', { topic, timeoutMs }),
  },
  spawnAgent: {
    exposedName: 'spawnAgent',
    create: (call) => (prompt: string) =>
      call('spawnAgent', { prompt }),
  },
  sendToAgent: {
    exposedName: 'sendToAgent',
    create: (call) => (agentId: string, message: string) =>
      call('sendToAgent', { agentId, message }),
  },
  startTask: {
    exposedName: 'startTask',
    create: (call) => (taskId: number, input?: unknown) =>
      call('startTask', { taskId, input }),
  },
  stopTask: {
    exposedName: 'stopTask',
    create: (call) => (runId: string) =>
      call('stopTask', { runId }),
  },
}

async function executeRequest(message: WorkerExecuteRequestMessage): Promise<void> {
  const { requestId, code, timeoutMs, input, methods } = message
  const abortController = new AbortController()
  activeRequests.set(requestId, abortController)

  const { logs, restore } = captureConsole(requestId)
  const capturedImages: ExecJsCapturedImage[] = []

  try {
    const signal = abortController.signal

    const call = (method: string, params: unknown) =>
      callHostMethod('' + requestId, method, params, signal)

    // Shadow browser/Node globals
    const shadowParamNames = [
      'window', 'self', 'globalThis', 'document',
      'require', 'global', 'Buffer', 'module', '__filename', '__dirname',
    ]
    const shadowArgValues: unknown[] = Array(shadowParamNames.length).fill(undefined)

    // Build method wrappers from the methods list
    const methodParamNames: string[] = []
    const methodArgValues: Function[] = []

    for (const method of methods) {
      const wrapper = builtInWrappers[method]
      if (wrapper) {
        methodParamNames.push(wrapper.exposedName)
        methodArgValues.push(wrapper.create(call, capturedImages))
      } else {
        methodParamNames.push(method)
        methodArgValues.push((params: unknown) => call(method, params))
      }
    }

    const fn = new AsyncFunction(
      ...shadowParamNames,
      ...methodParamNames,
      'input',
      `"use strict";\nreturn await (async () => {\n${code}\n})();`
    )

    const value = await withTimeoutAndAbort(
      fn(
        ...shadowArgValues,
        ...methodArgValues,
        input,
      ),
      timeoutMs,
      abortController.signal
    )

    const details: ExecJsDetails = {
      ok: true,
      value,
      logs,
      images: capturedImages,
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
      error: serializeError(error),
      logs,
      images: capturedImages,
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
