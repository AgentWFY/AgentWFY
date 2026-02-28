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
    const runSql = (params: WorkerHostMethodMap['runSql']['params']) =>
      callHostMethod('' + requestId, 'runSql', params, abortController.signal)
    const read = (params: WorkerHostMethodMap['read']['params']) =>
      callHostMethod('' + requestId, 'read', params, abortController.signal)
    const write = (params: WorkerHostMethodMap['write']['params']) =>
      callHostMethod('' + requestId, 'write', params, abortController.signal)
    const edit = (params: WorkerHostMethodMap['edit']['params']) =>
      callHostMethod('' + requestId, 'edit', params, abortController.signal)
    const ls = (params: WorkerHostMethodMap['ls']['params']) =>
      callHostMethod('' + requestId, 'ls', params, abortController.signal)
    const mkdir = (params: WorkerHostMethodMap['mkdir']['params']) =>
      callHostMethod('' + requestId, 'mkdir', params, abortController.signal)
    const remove = (params: WorkerHostMethodMap['remove']['params']) =>
      callHostMethod('' + requestId, 'remove', params, abortController.signal)
    const find = (params: WorkerHostMethodMap['find']['params']) =>
      callHostMethod('' + requestId, 'find', params, abortController.signal)
    const grep = (params: WorkerHostMethodMap['grep']['params']) =>
      callHostMethod('' + requestId, 'grep', params, abortController.signal)
    const getTabs = (params: WorkerHostMethodMap['getTabs']['params']) =>
      callHostMethod('' + requestId, 'getTabs', params ?? {}, abortController.signal)
    const openTab = (params: WorkerHostMethodMap['openTab']['params']) =>
      callHostMethod('' + requestId, 'openTab', params, abortController.signal)
    const closeTab = (params: WorkerHostMethodMap['closeTab']['params']) =>
      callHostMethod('' + requestId, 'closeTab', params, abortController.signal)
    const selectTab = (params: WorkerHostMethodMap['selectTab']['params']) =>
      callHostMethod('' + requestId, 'selectTab', params, abortController.signal)
    const reloadTab = (params: WorkerHostMethodMap['reloadTab']['params']) =>
      callHostMethod('' + requestId, 'reloadTab', params, abortController.signal)
    const captureTab = async (params: WorkerHostMethodMap['captureTab']['params']) => {
      const result = await callHostMethod('' + requestId, 'captureTab', params, abortController.signal)
      capturedImages.push({ base64: result.base64, mimeType: result.mimeType })
      return { captured: true, mimeType: result.mimeType }
    }
    const getTabConsoleLogs = (params: WorkerHostMethodMap['getTabConsoleLogs']['params']) =>
      callHostMethod('' + requestId, 'getTabConsoleLogs', params, abortController.signal)
    const execTabJs = (params: WorkerHostMethodMap['execTabJs']['params']) =>
      callHostMethod('' + requestId, 'execTabJs', params, abortController.signal)
    const publish = (topic: string, data: unknown) =>
      callHostMethod('' + requestId, 'busPublish', { topic, data }, abortController.signal)
    const waitFor = (topic: string, timeoutMs?: number) =>
      callHostMethod('' + requestId, 'busWaitFor', { topic, timeoutMs }, abortController.signal)
    const spawnAgent = (params: { prompt: string }) =>
      callHostMethod('' + requestId, 'spawnAgent', params, abortController.signal)

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
