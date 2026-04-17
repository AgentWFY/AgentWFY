import { utilityProcess } from 'electron'
import path from 'path'
import crypto from 'crypto'
import type {
  ExecJsDetails,
  ExecJsSerializedError,
  HostToWorkerMessage,
  WorkerHostCallMessage,
  WorkerToHostMessage,
} from './types.js'
import type { FunctionRegistry } from './function_registry.js'
import { resolveTimeout } from './timeout_utils.js'

const DEFAULT_EXEC_TIMEOUT_MS = 5000

type PendingExecution = {
  requestId: string
  resolve: (details: ExecJsDetails) => void
  reject: (error: unknown) => void
  cleanup?: () => void
}

type ChildEntry = {
  sessionId: string
  child: Electron.UtilityProcess
  pendingExecutions: Map<string, PendingExecution>
  onMessage: (message: WorkerToHostMessage) => void
  onExit: (code: number) => void
  lastCrashError?: string
  stderrChunks: string[]
}

export interface JsRuntimeDeps {
  functionRegistry: FunctionRegistry
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function serializeError(error: unknown): ExecJsSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
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

export class JsRuntime {
  private readonly workers = new Map<string, ChildEntry>()
  private readonly deps: JsRuntimeDeps

  constructor(deps: JsRuntimeDeps) {
    this.deps = deps
  }

  ensureWorker(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    if (this.workers.has(normalizedSessionId)) {
      return
    }

    const child = utilityProcess.fork(
      path.join(import.meta.dirname, 'exec_worker.js'),
      [],
      { serviceName: 'exec-worker-' + normalizedSessionId, stdio: 'pipe' },
    )

    const entry: ChildEntry = {
      sessionId: normalizedSessionId,
      child,
      pendingExecutions: new Map(),
      onMessage: () => {},
      onExit: () => {},
      stderrChunks: [],
    }

    if (child.stderr) {
      let stderrBytes = 0
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderrBytes += text.length
        entry.stderrChunks.push(text)
        while (stderrBytes > 65536 && entry.stderrChunks.length > 1) {
          stderrBytes -= entry.stderrChunks.shift()!.length
        }
      })
    }

    entry.onMessage = (message: WorkerToHostMessage) => {
      this.handleWorkerMessage(entry, message)
    }

    entry.onExit = (code: number) => {
      let errorMessage: string
      if (code === 0) {
        errorMessage = `Session worker exited for ${normalizedSessionId}`
      } else {
        errorMessage = `Session worker crashed with code ${code} for ${normalizedSessionId}`
        if (entry.lastCrashError) {
          errorMessage += `\n${entry.lastCrashError}`
        }
        const stderr = entry.stderrChunks.join('').trim()
        if (stderr) {
          errorMessage += `\nstderr: ${stderr}`
        }
      }
      this.disposeEntry(entry, new Error(errorMessage))
    }

    child.on('message', entry.onMessage)
    child.on('exit', entry.onExit)

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
    signal?: AbortSignal,
    input?: unknown
  ): Promise<ExecJsDetails> {
    const normalizedSessionId = normalizeSessionId(sessionId)
    this.ensureWorker(normalizedSessionId)

    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      throw new Error(`Failed to create session worker for ${normalizedSessionId}`)
    }

    const { timeoutMs: timeout, wasDefault } = resolveTimeout(timeoutMs, DEFAULT_EXEC_TIMEOUT_MS)

    if (signal?.aborted) {
      return {
        ok: false,
        error: {
          name: 'Error',
          message: 'JavaScript execution aborted',
        },
        logs: [],
        files: [],
        timeoutMs: timeout,
      }
    }

    const requestId = createId('exec-js')

    return new Promise<ExecJsDetails>((resolve, reject) => {
      const pending: PendingExecution = {
        requestId,
        resolve,
        reject,
      }

      if (signal) {
        const onAbort = () => {
          entry.child.postMessage({
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

      entry.child.postMessage({
        type: 'exec:run',
        requestId,
        code,
        timeoutMs: timeout,
        timeoutWasDefault: wasDefault,
        input,
        methods: this.deps.functionRegistry.getMethodNames(),
      } satisfies HostToWorkerMessage)
    })
  }

  disposeAll(): void {
    for (const entry of this.workers.values()) {
      this.disposeEntry(entry, new Error(`Session worker disposed for ${entry.sessionId}`))
    }
  }

  private handleWorkerMessage(entry: ChildEntry, message: WorkerToHostMessage): void {
    if (!message || typeof message !== 'object' || typeof (message as unknown as Record<string, unknown>).type !== 'string') {
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
      case 'worker:crash': {
        const err = message.error
        entry.lastCrashError = err.stack ?? `${err.name}: ${err.message}`
        return
      }
      default:
        return
    }
  }

  private async handleHostCall(entry: ChildEntry, message: WorkerHostCallMessage): Promise<void> {
    try {
      const value = await this.deps.functionRegistry.call(message.method, message.params)
      entry.child.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: true,
        value,
      } satisfies HostToWorkerMessage)
    } catch (error) {
      entry.child.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: false,
        error: serializeError(error),
      } satisfies HostToWorkerMessage)
    }
  }

  private disposeEntry(entry: ChildEntry, error: Error): void {
    if (!this.workers.has(entry.sessionId)) {
      return
    }

    this.workers.delete(entry.sessionId)

    entry.child.removeListener('message', entry.onMessage)
    entry.child.removeListener('exit', entry.onExit)

    for (const [, pending] of entry.pendingExecutions) {
      pending.cleanup?.()
      pending.reject(error)
    }

    entry.pendingExecutions.clear()

    entry.child.kill()
  }
}
