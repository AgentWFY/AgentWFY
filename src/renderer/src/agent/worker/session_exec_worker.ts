/// <reference lib="webworker" />

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
} from './types'

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

type PendingHostCall = {
  requestId: string
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>

const pendingHostCalls = new Map<string, PendingHostCall>()
const activeRequests = new Map<string, AbortController>()

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

function captureConsole(): { logs: ExecJsLogEntry[]; restore: () => void } {
  const methods: ConsoleMethod[] = ['debug', 'log', 'info', 'warn', 'error']
  const logs: ExecJsLogEntry[] = []
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>()

  methods.forEach((method) => {
    const original = console[method].bind(console)
    originals.set(method, original)

    console[method] = (...args: unknown[]) => {
      logs.push({
        level: method,
        message: truncate(args.map((arg) => stringifyUnknown(arg)).join(' '), 5000),
        timestamp: Date.now(),
      })
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
    },
  }
}

function withTimeoutAndAbort<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const timerId = workerScope.setTimeout(() => {
      reject(new Error(`JavaScript execution timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.finally(() => workerScope.clearTimeout(timerId)).catch(() => {})
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
  workerScope.postMessage(message)
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
  const { requestId, code, timeoutMs } = message
  const abortController = new AbortController()
  activeRequests.set(requestId, abortController)

  const { logs, restore } = captureConsole()
  const capturedImages: ExecJsCapturedImage[] = []

  try {
    const runSql = (request: WorkerHostMethodMap['runSql']['params']) =>
      callHostMethod('' + requestId, 'runSql', request, abortController.signal)
    const read = (path: string, offset?: number, limit?: number) =>
      callHostMethod('' + requestId, 'read', { path, offset, limit }, abortController.signal)
    const write = (path: string, content: string) =>
      callHostMethod('' + requestId, 'write', { path, content }, abortController.signal)
    const edit = (path: string, oldText: string, newText: string) =>
      callHostMethod('' + requestId, 'edit', { path, oldText, newText }, abortController.signal)
    const ls = (path?: string, limit?: number) =>
      callHostMethod('' + requestId, 'ls', { path, limit }, abortController.signal)
    const mkdir = (path: string, recursive?: boolean) =>
      callHostMethod('' + requestId, 'mkdir', { path, recursive }, abortController.signal)
    const remove = (path: string, recursive?: boolean) =>
      callHostMethod('' + requestId, 'remove', { path, recursive }, abortController.signal)
    const find = (pattern: string, path?: string, limit?: number) =>
      callHostMethod('' + requestId, 'find', { pattern, path, limit }, abortController.signal)
    const grep = (pattern: string, path?: string, options?: WorkerHostMethodMap['grep']['params']['options']) =>
      callHostMethod('' + requestId, 'grep', { pattern, path, options }, abortController.signal)
    const getTabs = () =>
      callHostMethod('' + requestId, 'getTabs', {}, abortController.signal)
    const openTab = (request: WorkerHostMethodMap['openTab']['params']) =>
      callHostMethod('' + requestId, 'openTab', request, abortController.signal)
    const closeTab = (request: WorkerHostMethodMap['closeTab']['params']) =>
      callHostMethod('' + requestId, 'closeTab', request, abortController.signal)
    const selectTab = (request: WorkerHostMethodMap['selectTab']['params']) =>
      callHostMethod('' + requestId, 'selectTab', request, abortController.signal)
    const reloadTab = (request: WorkerHostMethodMap['reloadTab']['params']) =>
      callHostMethod('' + requestId, 'reloadTab', request, abortController.signal)
    const captureTab = async (request: WorkerHostMethodMap['captureTab']['params']) => {
      const result = await callHostMethod('' + requestId, 'captureTab', request, abortController.signal)
      capturedImages.push({ base64: result.base64, mimeType: result.mimeType })
      return { captured: true, mimeType: result.mimeType }
    }
    const getTabConsoleLogs = (request: WorkerHostMethodMap['getTabConsoleLogs']['params']) =>
      callHostMethod('' + requestId, 'getTabConsoleLogs', request, abortController.signal)
    const execTabJs = (request: WorkerHostMethodMap['execTabJs']['params']) =>
      callHostMethod('' + requestId, 'execTabJs', request, abortController.signal)
    const publish = (topic: string, data: unknown) =>
      callHostMethod('' + requestId, 'busPublish', { topic, data }, abortController.signal)
    const waitFor = (topic: string, timeoutMs?: number) =>
      callHostMethod('' + requestId, 'busWaitFor', { topic, timeoutMs }, abortController.signal)
    const spawnAgent = (prompt: string) =>
      callHostMethod('' + requestId, 'spawnAgent', { prompt }, abortController.signal)

    const fn = new AsyncFunction(
      'window',
      'self',
      'globalThis',
      'document',
      'runSql',
      'read',
      'write',
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
      `"use strict";\nreturn await (async () => {\n${code}\n})();`
    )

    const value = await withTimeoutAndAbort(
      fn(
        globalThis,
        globalThis,
        globalThis,
        undefined,
        runSql,
        read,
        write,
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
        spawnAgent
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

workerScope.addEventListener('message', (event: MessageEvent<HostToWorkerMessage>) => {
  const message = event.data
  if (!message || typeof message !== 'object' || typeof (message as any).type !== 'string') {
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
    default:
      return
  }
})
