import { fork as forkChild, type ChildProcess } from 'node:child_process'
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
import type { TraceWriter } from './trace_writer.js'
import {
  TRACE_VERSION,
  TRACE_CODE_CAP,
  TRACE_PARAMS_CAP,
  TRACE_RESULT_CAP,
  stringifySafe,
  truncateWithFlag,
  toTraceError,
} from './trace_types.js'

const DEFAULT_EXEC_TIMEOUT_MS = 10000

type PendingExecution = {
  requestId: string
  resolve: (details: ExecJsDetails) => void
  reject: (error: unknown) => void
  cleanup?: () => void
  traceCode?: string
  traceDescription?: string
  traceStartedAt?: number
  traceTimeoutMs?: number
  traceSessionId?: string
}

type ChildEntry = {
  sessionId: string
  child: ChildProcess
  pendingExecutions: Map<string, PendingExecution>
  onMessage: (message: WorkerToHostMessage) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  lastCrashError?: string
  stderrChunks: string[]
}

export interface JsRuntimeDeps {
  functionRegistry: FunctionRegistry
  traceWriter?: TraceWriter
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

    // Spawn the worker as a Node-mode subprocess of the current Electron
    // binary. Why not utilityProcess.fork? Electron filters Node CLI flags via
    // an allowlist (shell/common/node_bindings.cc — IsAllowedOption) and
    // `--permission` is not on it, so the flag is silently dropped and the
    // permission model never activates. ELECTRON_RUN_AS_NODE=1 makes the
    // Electron binary behave as plain Node, skipping that filter entirely.
    //
    // Lock-down: --permission with no allowances. The worker can only:
    //   - read its own entry script (auto-allowed by Node; no flag needed)
    //   - reach the network (permission model has no net gate; `fetch` works)
    // It cannot read/write the filesystem, spawn child processes, create
    // worker threads, load native addons, or use WASI.
    //
    // The .mjs extension keeps this strict: Node skips the parent-dir
    // package.json walk that .js triggers for ESM type detection.
    //
    // Trade-offs vs utilityProcess.fork: the worker no longer shows up as a
    // named Electron service in the OS process list, and we lose the
    // automatic crash-reporter integration. We still capture stderr.
    const child = forkChild(
      path.join(import.meta.dirname, 'exec_worker.mjs'),
      [],
      {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: ['--permission'],
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
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

    entry.onExit = (code, signal) => {
      let errorMessage: string
      if (code === 0) {
        errorMessage = `Session worker exited for ${normalizedSessionId}`
      } else {
        const cause = signal ? `signal ${signal}` : `code ${code}`
        errorMessage = `Session worker crashed with ${cause} for ${normalizedSessionId}`
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
    input?: unknown,
    description?: string,
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
        traceCode: code,
        traceDescription: description,
        traceStartedAt: Date.now(),
        traceTimeoutMs: timeout,
        traceSessionId: normalizedSessionId,
      }

      if (signal) {
        const onAbort = () => {
          entry.child.send({
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

      entry.child.send({
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
        try {
          this.emitExecTrace(pending, message.requestId, message.details)
        } catch (err) {
          // Tracing is observational — never let a trace-side bug swallow the
          // exec result or hang the tool call.
          console.error('[trace] emitExecTrace failed:', err)
        }
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
    const traceStartedAt = Date.now()
    try {
      const value = await this.deps.functionRegistry.call(message.method, message.params)
      this.safeEmitCallTrace(entry, message, traceStartedAt, value, null)
      entry.child.send({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: true,
        value,
      } satisfies HostToWorkerMessage)
    } catch (error) {
      this.safeEmitCallTrace(entry, message, traceStartedAt, undefined, error)
      entry.child.send({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: false,
        error: serializeError(error),
      } satisfies HostToWorkerMessage)
    }
  }

  private safeEmitCallTrace(
    entry: ChildEntry,
    message: WorkerHostCallMessage,
    startedAt: number,
    value: unknown,
    error: unknown,
  ): void {
    try {
      this.emitCallTrace(entry, message, startedAt, value, error)
    } catch (err) {
      console.error('[trace] emitCallTrace failed:', err)
    }
  }

  private emitExecTrace(pending: PendingExecution, requestId: string, details: ExecJsDetails): void {
    const writer = this.deps.traceWriter
    if (!writer) return
    if (!pending.traceSessionId || pending.traceStartedAt === undefined) return

    const startedAt = pending.traceStartedAt
    const durationMs = Date.now() - startedAt
    const codeRaw = pending.traceCode ?? ''
    const code = truncateWithFlag(codeRaw, TRACE_CODE_CAP)

    let resultPreview: string | null = null
    let resultTruncated = false
    if (details.ok && 'value' in details) {
      const preview = truncateWithFlag(stringifySafe((details as { value: unknown }).value), TRACE_RESULT_CAP)
      resultPreview = preview.text
      resultTruncated = preview.truncated
    }

    writer.append({
      v: TRACE_VERSION,
      t: 'exec',
      id: requestId,
      sessionId: pending.traceSessionId,
      description: pending.traceDescription ?? '',
      code: code.text,
      codeTruncated: code.truncated,
      startedAt,
      durationMs,
      ok: details.ok,
      error: details.ok ? null : toTraceError(details.error),
      resultPreview,
      resultTruncated,
      timeoutMs: pending.traceTimeoutMs ?? details.timeoutMs,
    })
  }

  private emitCallTrace(
    entry: ChildEntry,
    message: WorkerHostCallMessage,
    startedAt: number,
    value: unknown,
    error: unknown,
  ): void {
    const writer = this.deps.traceWriter
    if (!writer) return

    const durationMs = Date.now() - startedAt
    const params = truncateWithFlag(stringifySafe(message.params), TRACE_PARAMS_CAP)
    const ok = error === null
    let resultPreview: string | null = null
    let resultTruncated = false
    if (ok && value !== undefined) {
      const preview = truncateWithFlag(stringifySafe(value), TRACE_RESULT_CAP)
      resultPreview = preview.text
      resultTruncated = preview.truncated
    }

    writer.append({
      v: TRACE_VERSION,
      t: 'call',
      id: message.callId,
      execId: message.requestId,
      sessionId: entry.sessionId,
      method: message.method,
      paramsPreview: params.text,
      paramsTruncated: params.truncated,
      resultPreview,
      resultTruncated,
      startedAt,
      durationMs,
      ok,
      error: ok ? null : toTraceError(error),
    })
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
      // Record a synthetic failure trace so the timeline matches the message
      // log — agents see the call as errored via toFailureDetails, and the
      // trace viewer should not silently skip it.
      const syntheticDetails: ExecJsDetails = {
        ok: false,
        error: { name: error.name || 'Error', message: error.message },
        logs: [],
        files: [],
        timeoutMs: pending.traceTimeoutMs ?? 0,
      }
      try {
        this.emitExecTrace(pending, pending.requestId, syntheticDetails)
      } catch (err) {
        console.error('[trace] emitExecTrace failed:', err)
      }
      pending.reject(error)
    }

    entry.pendingExecutions.clear()

    entry.child.kill()
  }
}
