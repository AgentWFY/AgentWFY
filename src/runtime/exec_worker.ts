import type {
  ExecJsCapturedImage,
  ExecJsDetails,
  ExecJsSerializedError,
  ExecJsLogEntry,
  HostToWorkerMessage,
  WorkerHostMethod,
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

async function callHostMethod<M extends WorkerHostMethod>(
  requestId: string,
  method: M,
  params: WorkerHostMethodMap[M]['params'],
  signal: AbortSignal
): Promise<WorkerHostMethodMap[M]['result']> {
  if (signal.aborted) {
    throw new Error('JavaScript execution aborted')
  }

  const callId = createId('host-call')

  return new Promise<WorkerHostMethodMap[M]['result']>((resolve, reject) => {
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
        resolve(value as WorkerHostMethodMap[M]['result'])
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
  const { requestId, code, timeoutMs, input, pluginMethods } = message
  const abortController = new AbortController()
  activeRequests.set(requestId, abortController)

  const { logs, restore } = captureConsole(requestId)
  const capturedImages: ExecJsCapturedImage[] = []

  try {
    const signal = abortController.signal

    const runSql = (request: WorkerHostMethodMap['runSql']['params']) =>
      callHostMethod('' + requestId, 'runSql', request, signal)
    const read = (path: string, offset?: number, limit?: number) =>
      callHostMethod('' + requestId, 'read', { path, offset, limit }, signal)
    const write = (path: string, content: string) =>
      callHostMethod('' + requestId, 'write', { path, content }, signal)
    const writeBinary = (path: string, base64: string) =>
      callHostMethod('' + requestId, 'writeBinary', { path, base64 }, signal)
    const edit = (path: string, oldText: string, newText: string) =>
      callHostMethod('' + requestId, 'edit', { path, oldText, newText }, signal)
    const ls = (path?: string, limit?: number) =>
      callHostMethod('' + requestId, 'ls', { path, limit }, signal)
    const mkdir = (path: string, recursive?: boolean) =>
      callHostMethod('' + requestId, 'mkdir', { path, recursive }, signal)
    const remove = (path: string, recursive?: boolean) =>
      callHostMethod('' + requestId, 'remove', { path, recursive }, signal)
    const find = (pattern: string, path?: string, limit?: number) =>
      callHostMethod('' + requestId, 'find', { pattern, path, limit }, signal)
    const grep = (pattern: string, path?: string, options?: WorkerHostMethodMap['grep']['params']['options']) =>
      callHostMethod('' + requestId, 'grep', { pattern, path, options }, signal)
    const getTabs = () =>
      callHostMethod('' + requestId, 'getTabs', {}, signal)
    const openTab = (request: WorkerHostMethodMap['openTab']['params']) =>
      callHostMethod('' + requestId, 'openTab', request, signal)
    const closeTab = (request: WorkerHostMethodMap['closeTab']['params']) =>
      callHostMethod('' + requestId, 'closeTab', request, signal)
    const selectTab = (request: WorkerHostMethodMap['selectTab']['params']) =>
      callHostMethod('' + requestId, 'selectTab', request, signal)
    const reloadTab = (request: WorkerHostMethodMap['reloadTab']['params']) =>
      callHostMethod('' + requestId, 'reloadTab', request, signal)
    const captureTab = async (request: WorkerHostMethodMap['captureTab']['params']) => {
      const result = await callHostMethod('' + requestId, 'captureTab', request, signal)
      capturedImages.push({ base64: result.base64, mimeType: result.mimeType })
      return { captured: true, mimeType: result.mimeType }
    }
    const getTabConsoleLogs = (request: WorkerHostMethodMap['getTabConsoleLogs']['params']) =>
      callHostMethod('' + requestId, 'getTabConsoleLogs', request, signal)
    const execTabJs = (request: WorkerHostMethodMap['execTabJs']['params']) =>
      callHostMethod('' + requestId, 'execTabJs', request, signal)
    const publish = (topic: string, data: unknown) =>
      callHostMethod('' + requestId, 'busPublish', { topic, data }, signal)
    const waitFor = (topic: string, timeoutMs?: number) =>
      callHostMethod('' + requestId, 'busWaitFor', { topic, timeoutMs }, signal)
    const spawnAgent = (prompt: string) =>
      callHostMethod('' + requestId, 'spawnAgent', { prompt }, signal)
    const sendToAgent = (agentId: string, message: string) =>
      callHostMethod('' + requestId, 'sendToAgent', { agentId, message }, signal)
    const startTask = (taskId: number, input?: unknown) =>
      callHostMethod('' + requestId, 'startTask', { taskId, input }, signal)
    const stopTask = (runId: string) =>
      callHostMethod('' + requestId, 'stopTask', { runId }, signal)
    // Build plugin function wrappers
    const pluginFnNames: string[] = []
    const pluginFnValues: Function[] = []
    for (const name of (pluginMethods ?? [])) {
      pluginFnNames.push(name)
      pluginFnValues.push((params: unknown) =>
        callHostMethod('' + requestId, `plugin:${name}` as WorkerHostMethod, params, signal)
      )
    }

    const builtInParamNames = [
      // Shadow browser globals
      'window',
      'self',
      'globalThis',
      'document',
      // Shadow Node.js globals to prevent direct access
      'require',
      'global',
      'Buffer',
      'module',
      '__filename',
      '__dirname',
      // Host methods
      'runSql',
      'read',
      'write',
      'writeBinary',
      'edit',
      'ls',
      'mkdir',
      'remove',
      'find',
      'grep',
      'getTabs',
      'openTab',
      'closeTab',
      'selectTab',
      'reloadTab',
      'captureTab',
      'getTabConsoleLogs',
      'execTabJs',
      'publish',
      'waitFor',
      'spawnAgent',
      'sendToAgent',
      'startTask',
      'stopTask',
      'input',
    ]

    const builtInArgValues = [
      // Shadow browser globals
      undefined,
      undefined,
      undefined,
      undefined,
      // Shadow Node.js globals
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Host methods
      runSql,
      read,
      write,
      writeBinary,
      edit,
      ls,
      mkdir,
      remove,
      find,
      grep,
      getTabs,
      openTab,
      closeTab,
      selectTab,
      reloadTab,
      captureTab,
      getTabConsoleLogs,
      execTabJs,
      publish,
      waitFor,
      spawnAgent,
      sendToAgent,
      startTask,
      stopTask,
      input,
    ]

    const fn = new AsyncFunction(
      ...builtInParamNames,
      ...pluginFnNames,
      `"use strict";\nreturn await (async () => {\n${code}\n})();`
    )

    const value = await withTimeoutAndAbort(
      fn(
        ...builtInArgValues,
        ...pluginFnValues,
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
