import type {
  ExecJsDetails,
  ExecJsSerializedError,
  HostToWorkerMessage,
  WorkerHostCallMessage,
  WorkerHostMethod,
  WorkerHostMethodMap,
  WorkerToHostMessage,
  WorkerTabConsoleLogEntry,
} from './types'
import { bus } from '../event-bus'
import { getSessionManager } from '../agent/session_manager'
import { getTaskRunner } from '../tasks/task_runner'

const DEFAULT_EXEC_TIMEOUT_MS = 5000

type PendingExecution = {
  resolve: (details: ExecJsDetails) => void
  reject: (error: unknown) => void
  cleanup?: () => void
}

type WorkerEntry = {
  sessionId: string
  worker: Worker
  pendingExecutions: Map<string, PendingExecution>
  onMessage: (event: MessageEvent<WorkerToHostMessage>) => void
  onError: (event: ErrorEvent) => void
  onMessageError: (event: MessageEvent) => void
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    message: String(error),
  }
}

function normalizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId is required for execJs worker execution')
  }

  return sessionId.trim()
}

function getIpc() {
  if (!window.ipc) {
    throw new Error('window.ipc is not available in this renderer context')
  }

  return window.ipc
}

export class JsRuntime {
  private readonly workers = new Map<string, WorkerEntry>()

  ensureWorker(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    if (this.workers.has(normalizedSessionId)) {
      return
    }

    const worker = new Worker(new URL('./exec_worker.ts', import.meta.url), {
      type: 'module',
    })

    const entry: WorkerEntry = {
      sessionId: normalizedSessionId,
      worker,
      pendingExecutions: new Map(),
      onMessage: () => {},
      onError: () => {},
      onMessageError: () => {},
    }

    entry.onMessage = (event: MessageEvent<WorkerToHostMessage>) => {
      this.handleWorkerMessage(entry, event.data)
    }

    entry.onError = (event: ErrorEvent) => {
      const message = event.error instanceof Error
        ? event.error
        : new Error(event.message || `Session worker failed for ${normalizedSessionId}`)
      this.disposeEntry(entry, message)
    }

    entry.onMessageError = () => {
      this.disposeEntry(entry, new Error(`Failed to deserialize message from session worker ${normalizedSessionId}`))
    }

    worker.addEventListener('message', entry.onMessage)
    worker.addEventListener('error', entry.onError)
    worker.addEventListener('messageerror', entry.onMessageError)

    this.workers.set(normalizedSessionId, entry)
  }

  terminateWorker(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      return
    }

    this.disposeEntry(entry, new Error(`Session worker terminated for ${normalizedSessionId}`))
  }

  async executeExecJs(
    sessionId: string,
    code: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<ExecJsDetails> {
    const normalizedSessionId = normalizeSessionId(sessionId)
    this.ensureWorker(normalizedSessionId)

    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      throw new Error(`Failed to create session worker for ${normalizedSessionId}`)
    }

    const timeout = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
      ? Math.floor(timeoutMs as number)
      : DEFAULT_EXEC_TIMEOUT_MS

    if (signal?.aborted) {
      return {
        ok: false,
        error: {
          name: 'Error',
          message: 'JavaScript execution aborted',
        },
        logs: [],
        timeoutMs: timeout,
      }
    }

    const requestId = createId('exec-js')

    return new Promise<ExecJsDetails>((resolve, reject) => {
      const pending: PendingExecution = {
        resolve,
        reject,
      }

      if (signal) {
        const onAbort = () => {
          entry.worker.postMessage({
            type: 'exec:cancel',
            requestId,
          } satisfies HostToWorkerMessage)
        }

        signal.addEventListener('abort', onAbort, { once: true })
        pending.cleanup = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }

      entry.pendingExecutions.set(requestId, pending)

      entry.worker.postMessage({
        type: 'exec:run',
        requestId,
        code,
        timeoutMs: timeout,
      } satisfies HostToWorkerMessage)
    })
  }

  disposeAll(): void {
    for (const entry of this.workers.values()) {
      this.disposeEntry(entry, new Error(`Session worker disposed for ${entry.sessionId}`))
    }
  }

  private handleWorkerMessage(entry: WorkerEntry, message: WorkerToHostMessage): void {
    if (!message || typeof message !== 'object' || typeof (message as Record<string, unknown>).type !== 'string') {
      return
    }

    switch (message.type) {
      case 'exec:result': {
        const pending = entry.pendingExecutions.get(message.requestId)
        if (!pending) {
          return
        }

        entry.pendingExecutions.delete(message.requestId)
        pending.cleanup?.()
        pending.resolve(message.details)
        return
      }
      case 'host:call': {
        void this.handleHostCall(entry, message)
        return
      }
      default:
        return
    }
  }

  private async handleHostCall(entry: WorkerEntry, message: WorkerHostCallMessage): Promise<void> {
    try {
      const value = await this.invokeHostMethod(message.method, message.params)
      entry.worker.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: true,
        value,
      } satisfies HostToWorkerMessage)
    } catch (error) {
      entry.worker.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: false,
        error: serializeError(error),
      } satisfies HostToWorkerMessage)
    }
  }

  private async invokeHostMethod<M extends WorkerHostMethod>(
    method: M,
    params: unknown
  ): Promise<WorkerHostMethodMap[M]['result']> {
    const ipc = getIpc()

    switch (method) {
      case 'runSql': {
        const request = params as WorkerHostMethodMap['runSql']['params']
        if (!request || typeof request.sql !== 'string' || request.sql.trim().length === 0) {
          throw new Error('runSql requires a non-empty sql string')
        }

        const result = await ipc.sql.run({
          target: request.target ?? 'agent',
          path: request.path,
          sql: request.sql,
          params: request.params,
          description: request.description,
        })
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'read': {
        const request = params as WorkerHostMethodMap['read']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('read requires a non-empty path string')
        }

        if (typeof request.offset !== 'undefined' && (!Number.isFinite(request.offset) || request.offset < 1)) {
          throw new Error('read offset must be a number >= 1 when provided')
        }

        if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
          throw new Error('read limit must be a number >= 1 when provided')
        }

        const result = await ipc.files.read(request.path, request.offset, request.limit)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'write': {
        const request = params as WorkerHostMethodMap['write']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('write requires a non-empty path string')
        }

        if (typeof request.content !== 'string') {
          throw new Error('write requires content as a string')
        }

        const result = await ipc.files.write(request.path, request.content)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'edit': {
        const request = params as WorkerHostMethodMap['edit']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('edit requires a non-empty path string')
        }
        if (typeof request.oldText !== 'string') {
          throw new Error('edit requires oldText as a string')
        }
        if (typeof request.newText !== 'string') {
          throw new Error('edit requires newText as a string')
        }

        const result = await ipc.files.edit(request.path, request.oldText, request.newText)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'ls': {
        const request = (params ?? {}) as WorkerHostMethodMap['ls']['params']
        if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
          throw new Error('ls path must be a string when provided')
        }

        if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
          throw new Error('ls limit must be a number >= 1 when provided')
        }

        const result = await ipc.files.ls(request.path, request.limit)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'mkdir': {
        const request = params as WorkerHostMethodMap['mkdir']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('mkdir requires a non-empty path string')
        }

        if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
          throw new Error('mkdir recursive must be a boolean when provided')
        }

        await ipc.files.mkdir(request.path, request.recursive)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'remove': {
        const request = params as WorkerHostMethodMap['remove']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('remove requires a non-empty path string')
        }

        if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
          throw new Error('remove recursive must be a boolean when provided')
        }

        await ipc.files.remove(request.path, request.recursive)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'find': {
        const request = params as WorkerHostMethodMap['find']['params']
        if (!request || typeof request.pattern !== 'string' || request.pattern.trim().length === 0) {
          throw new Error('find requires a non-empty pattern string')
        }

        if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
          throw new Error('find path must be a string when provided')
        }

        if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
          throw new Error('find limit must be a number >= 1 when provided')
        }

        const result = await ipc.files.find(request.pattern, request.path, request.limit)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'grep': {
        const request = params as WorkerHostMethodMap['grep']['params']
        if (!request || typeof request.pattern !== 'string' || request.pattern.trim().length === 0) {
          throw new Error('grep requires a non-empty pattern string')
        }

        if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
          throw new Error('grep path must be a string when provided')
        }

        if (typeof request.options !== 'undefined' && (request.options === null || typeof request.options !== 'object')) {
          throw new Error('grep options must be an object when provided')
        }

        const result = await ipc.files.grep(request.pattern, request.path, request.options)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'getTabs': {
        return ipc.tabs.getTabs() as Promise<WorkerHostMethodMap[M]['result']>
      }
      case 'openTab': {
        const request = params as WorkerHostMethodMap['openTab']['params']
        if (!request) {
          throw new Error('openTab requires a request object')
        }

        const hasViewId = typeof request.viewId === 'string' || typeof request.viewId === 'number'
        const hasFilePath = typeof request.filePath === 'string' && request.filePath.length > 0
        const hasUrl = typeof request.url === 'string' && request.url.length > 0
        const sourceCount = (hasViewId ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0)

        if (sourceCount !== 1) {
          throw new Error('openTab requires exactly one of viewId, filePath, or url')
        }

        await ipc.tabs.openTab({
          viewId: hasViewId ? request.viewId : undefined,
          filePath: hasFilePath ? request.filePath : undefined,
          url: hasUrl ? request.url : undefined,
          title: request.title,
        })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'closeTab': {
        const request = params as WorkerHostMethodMap['closeTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('closeTab requires a tabId')
        }

        await ipc.tabs.closeTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'selectTab': {
        const request = params as WorkerHostMethodMap['selectTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('selectTab requires a tabId')
        }

        await ipc.tabs.selectTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'reloadTab': {
        const request = params as WorkerHostMethodMap['reloadTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('reloadTab requires a tabId')
        }

        await ipc.tabs.reloadTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'captureTab': {
        const request = params as WorkerHostMethodMap['captureTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('captureTab requires a tabId')
        }

        return ipc.tabs.captureTab({ tabId: request.tabId }) as Promise<WorkerHostMethodMap[M]['result']>
      }
      case 'getTabConsoleLogs': {
        const request = params as WorkerHostMethodMap['getTabConsoleLogs']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('getTabConsoleLogs requires a tabId')
        }

        const logs = await ipc.tabs.getConsoleLogs({
          tabId: request.tabId,
          since: request.since,
          limit: request.limit,
        })
        return logs as WorkerTabConsoleLogEntry[] as WorkerHostMethodMap[M]['result']
      }
      case 'execTabJs': {
        const request = params as WorkerHostMethodMap['execTabJs']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('execTabJs requires a tabId')
        }
        if (typeof request.code !== 'string') {
          throw new Error('execTabJs requires JavaScript code as a string')
        }

        const result = await ipc.tabs.execJs({
          tabId: request.tabId,
          code: request.code,
          timeoutMs: request.timeoutMs,
        })
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'busPublish': {
        const request = params as WorkerHostMethodMap['busPublish']['params']
        if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
          throw new Error('busPublish requires a non-empty topic string')
        }
        bus.publish(request.topic, request.data)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'busWaitFor': {
        const request = params as WorkerHostMethodMap['busWaitFor']['params']
        if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
          throw new Error('busWaitFor requires a non-empty topic string')
        }
        const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 120_000
        const result = await bus.waitFor(request.topic, timeoutMs)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'setRequestHeaders': {
        const request = params as WorkerHostMethodMap['setRequestHeaders']['params']
        if (!request || typeof request.tid !== 'string' || !request.headers) {
          throw new Error('setRequestHeaders requires tid and headers')
        }
        await ipc.net.headers.set(request)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'spawnAgent': {
        const request = params as WorkerHostMethodMap['spawnAgent']['params']
        if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
          throw new Error('spawnAgent requires a non-empty prompt string')
        }
        const mgr = getSessionManager()
        if (!mgr) throw new Error('AgentSessionManager not initialized')
        const result = await mgr.spawnSession(request.prompt)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'startTask': {
        const request = params as WorkerHostMethodMap['startTask']['params']
        if (!request || typeof request.taskId !== 'number') {
          throw new Error('startTask requires a taskId number')
        }
        const taskRunner = getTaskRunner()
        if (!taskRunner) throw new Error('TaskRunner not initialized')
        const runId = await taskRunner.startTask(request.taskId)
        return { runId } as WorkerHostMethodMap[M]['result']
      }
      case 'stopTask': {
        const request = params as WorkerHostMethodMap['stopTask']['params']
        if (!request || typeof request.runId !== 'string' || request.runId.trim().length === 0) {
          throw new Error('stopTask requires a non-empty runId string')
        }
        const taskRunner = getTaskRunner()
        if (!taskRunner) throw new Error('TaskRunner not initialized')
        taskRunner.stopTask(request.runId)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      default:
        throw new Error(`Unsupported worker host method: ${String(method)}`)
    }
  }

  private disposeEntry(entry: WorkerEntry, error: Error): void {
    if (!this.workers.has(entry.sessionId)) {
      return
    }

    this.workers.delete(entry.sessionId)

    entry.worker.removeEventListener('message', entry.onMessage)
    entry.worker.removeEventListener('error', entry.onError)
    entry.worker.removeEventListener('messageerror', entry.onMessageError)

    for (const [, pending] of entry.pendingExecutions) {
      pending.cleanup?.()
      pending.reject(error)
    }

    entry.pendingExecutions.clear()

    entry.worker.terminate()
  }
}

const sharedJsRuntime = new JsRuntime()

export function getJsRuntime(): JsRuntime {
  return sharedJsRuntime
}

export function ensureWorker(sessionId: string): void {
  sharedJsRuntime.ensureWorker(sessionId)
}

export function terminateWorker(sessionId: string): void {
  sharedJsRuntime.terminateWorker(sessionId)
}
