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
const watchedRequests = new Set<string>()
const requestLogs = new Map<string, ExecJsLogEntry[]>()
const nativeFetch = workerScope.fetch.bind(workerScope)
const NativeWebSocket = workerScope.WebSocket

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

function extractHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const headers: Record<string, string> = {}
  if (raw instanceof Headers) {
    raw.forEach((v, k) => { headers[k] = v })
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      headers[k] = String(v)
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function tagUrl(url: string, key: string, value: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set(key, value)
  return parsed.toString()
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
    const startTask = (taskId: number) =>
      callHostMethod('' + requestId, 'startTask', { taskId }, signal)
    const stopTask = (runId: string) =>
      callHostMethod('' + requestId, 'stopTask', { runId }, signal)

    // Native fetch shadow: registers headers via IPC, appends _awfy_id, uses native fetch
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers ? extractHeaders(init.headers) : undefined
      if (headers) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const tid = createId('req')
        await callHostMethod('' + requestId, 'setRequestHeaders', { tid, headers }, signal)
        return nativeFetch(tagUrl(url, '_awfy_id', tid), {
          method: init?.method,
          body: init?.body,
          signal: init?.signal,
        })
      }
      return nativeFetch(input, init)
    }

    // WebSocket shadow: for custom headers/origin, registers via IPC then opens native WS with _awfy_id
    function WebSocket(
      url: string | URL,
      protocols?: string | string[] | null,
      options?: { origin?: string; headers?: Record<string, string> }
    ): InstanceType<typeof NativeWebSocket> {
      const urlStr = typeof url === 'string' ? url : url.toString()
      const prots = protocols === null ? undefined : protocols

      // No custom headers needed — return native WebSocket directly
      if (!options || (!options.headers && !options.origin)) {
        return new NativeWebSocket(urlStr, prots)
      }

      // Build headers map (include Origin if specified)
      const hdrs: Record<string, string> = { ...options.headers }
      if (options.origin) {
        hdrs['Origin'] = options.origin
      }

      // Create a wrapper that defers native WS creation until headers are registered
      const tid = createId('ws')
      const taggedUrl = tagUrl(urlStr, '_awfy_id', tid)

      // We need to create the native WS after async header registration.
      // Use a wrapper object that proxies to the real WS once created.
      const wrapper = Object.create(NativeWebSocket.prototype) as WebSocket
      let nativeWs: WebSocket | null = null
      let pendingClose: { code?: number; reason?: string } | null = null

      // Event handler storage
      let _onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
      let _onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
      let _onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
      let _onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null

      Object.defineProperties(wrapper, {
        url: { get: () => urlStr, enumerable: true },
        readyState: { get: () => nativeWs ? nativeWs.readyState : NativeWebSocket.CONNECTING, enumerable: true },
        protocol: { get: () => nativeWs ? nativeWs.protocol : '', enumerable: true },
        extensions: { get: () => nativeWs ? nativeWs.extensions : '', enumerable: true },
        bufferedAmount: { get: () => nativeWs ? nativeWs.bufferedAmount : 0, enumerable: true },
        binaryType: {
          get: () => nativeWs ? nativeWs.binaryType : 'blob',
          set: (v: BinaryType) => { if (nativeWs) nativeWs.binaryType = v },
          enumerable: true,
        },
        onopen: {
          get: () => _onopen,
          set: (v: ((this: WebSocket, ev: Event) => unknown) | null) => {
            _onopen = v
            if (nativeWs) nativeWs.onopen = v
          },
          enumerable: true,
        },
        onmessage: {
          get: () => _onmessage,
          set: (v: ((this: WebSocket, ev: MessageEvent) => unknown) | null) => {
            _onmessage = v
            if (nativeWs) nativeWs.onmessage = v
          },
          enumerable: true,
        },
        onerror: {
          get: () => _onerror,
          set: (v: ((this: WebSocket, ev: Event) => unknown) | null) => {
            _onerror = v
            if (nativeWs) nativeWs.onerror = v
          },
          enumerable: true,
        },
        onclose: {
          get: () => _onclose,
          set: (v: ((this: WebSocket, ev: CloseEvent) => unknown) | null) => {
            _onclose = v
            if (nativeWs) nativeWs.onclose = v
          },
          enumerable: true,
        },
      })

      // Queue of addEventListener calls made before native WS is ready
      const pendingListeners: Array<[string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean | undefined]> = []

      wrapper.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
        if (nativeWs) {
          nativeWs.addEventListener(type, listener, options)
        } else {
          pendingListeners.push([type, listener, options])
        }
      }

      wrapper.removeEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
        if (nativeWs) {
          nativeWs.removeEventListener(type, listener, options)
        } else {
          const idx = pendingListeners.findIndex(([t, l]) => t === type && l === listener)
          if (idx !== -1) pendingListeners.splice(idx, 1)
        }
      }

      wrapper.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (!nativeWs || nativeWs.readyState !== NativeWebSocket.OPEN) {
          throw new DOMException('WebSocket is not open', 'InvalidStateError')
        }
        nativeWs.send(data)
      }

      wrapper.close = function (code?: number, reason?: string) {
        if (nativeWs) {
          nativeWs.close(code, reason)
        } else {
          pendingClose = { code, reason }
        }
      }

      wrapper.dispatchEvent = function (event: Event): boolean {
        if (nativeWs) return nativeWs.dispatchEvent(event)
        return false
      }

      // Async: register headers then create native WS
      void callHostMethod('' + requestId, 'setRequestHeaders', { tid, headers: hdrs }, signal).then(() => {
        if (pendingClose) {
          // User called close() before we could connect
          return
        }
        nativeWs = new NativeWebSocket(taggedUrl, prots)

        // Apply stored on* handlers
        if (_onopen) nativeWs.onopen = _onopen
        if (_onmessage) nativeWs.onmessage = _onmessage
        if (_onerror) nativeWs.onerror = _onerror
        if (_onclose) nativeWs.onclose = _onclose

        // Apply queued addEventListener calls
        for (const [type, listener, opts] of pendingListeners) {
          nativeWs.addEventListener(type, listener, opts)
        }
        pendingListeners.length = 0
      }).catch(() => {
        // Fire error + close events on the wrapper via both on* and addEventListener listeners
        const errEv = new Event('error')
        if (_onerror) _onerror.call(wrapper, errEv)
        for (const [type, listener] of pendingListeners) {
          if (type === 'error') {
            if (typeof listener === 'function') { listener(errEv) } else { listener.handleEvent(errEv) }
          }
        }
        const closeEv = new CloseEvent('close', { code: 1006, reason: 'Header registration failed', wasClean: false })
        if (_onclose) _onclose.call(wrapper, closeEv)
        for (const [type, listener] of pendingListeners) {
          if (type === 'close') {
            if (typeof listener === 'function') { listener(closeEv) } else { listener.handleEvent(closeEv) }
          }
        }
        pendingListeners.length = 0
      })

      return wrapper as InstanceType<typeof NativeWebSocket>
    }

    // Copy static constants
    WebSocket.CONNECTING = NativeWebSocket.CONNECTING
    WebSocket.OPEN = NativeWebSocket.OPEN
    WebSocket.CLOSING = NativeWebSocket.CLOSING
    WebSocket.CLOSED = NativeWebSocket.CLOSED

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
      'fetch',
      'WebSocket',
      'spawnAgent',
      'startTask',
      'stopTask',
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
        fetch,
        WebSocket,
        spawnAgent,
        startTask,
        stopTask
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
  if (!message || typeof message !== 'object' || typeof (message as Record<string, unknown>).type !== 'string') {
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
