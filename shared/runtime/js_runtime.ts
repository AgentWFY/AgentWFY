import { fork as forkChild, type ChildProcess } from 'node:child_process'
import path from 'path'
import crypto from 'crypto'
import type {
  ExecJsDetails,
  ExecJsLogEntry,
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
  stringifyCapped,
  truncateWithFlag,
  toTraceError,
} from './trace_types.js'

const DEFAULT_EXEC_TIMEOUT_MS = 10000

/**
 * How long a session's worker may sit unused before it is killed.
 *
 * A worker is an Electron-as-Node subprocess costing ~50 MB resident and no
 * measurable CPU while idle, and one is pre-warmed for every session the user
 * opens — including sessions that never run any code. Nothing reclaimed them
 * short of closing the session, so a dozen open sessions held ~600 MB doing
 * nothing.
 *
 * Eviction is safe because execJs is documented as stateless — "Each execJs
 * call is self-contained — no state persists between calls", and `globalThis`
 * is `undefined` inside the worker, so an agent cannot carry state across
 * calls even by accident. Re-forking costs ~70 ms on the next execJs (vs
 * ~0.2 ms warm), which is invisible next to an LLM turn.
 */
const DEFAULT_IDLE_EVICT_MS = 5 * 60 * 1000
const MAX_SWEEP_INTERVAL_MS = 60 * 1000
const MIN_SWEEP_INTERVAL_MS = 250

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
  onLog?: (logEntry: ExecJsLogEntry) => void
}

type ChildEntry = {
  sessionId: string
  child: ChildProcess
  pendingExecutions: Map<string, PendingExecution>
  onMessage: (message: WorkerToHostMessage) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  onError: (error: Error) => void
  lastCrashError?: string
  stderrChunks: string[]
  /** Last time this worker was sent an exec or said anything back. */
  lastActivityAt: number
}

export interface JsRuntimeDeps {
  functionRegistry: FunctionRegistry
  traceWriter?: TraceWriter
  /** Override the idle-eviction window. 0 or negative disables eviction. */
  idleEvictMs?: number
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
  private readonly idleEvictMs: number
  private readonly sweepIntervalMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: JsRuntimeDeps) {
    this.deps = deps
    this.idleEvictMs = deps.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS
    // Check often enough that the window means something, without waking up
    // pointlessly on the 5-minute default.
    this.sweepIntervalMs = Math.max(
      MIN_SWEEP_INTERVAL_MS,
      Math.min(Math.floor(this.idleEvictMs / 4), MAX_SWEEP_INTERVAL_MS),
    )
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
      onError: () => {},
      stderrChunks: [],
      lastActivityAt: Date.now(),
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

    entry.onError = (error) => {
      this.disposeEntry(entry, new Error(`Session worker IPC error for ${normalizedSessionId}: ${error.message}`))
    }

    child.on('message', entry.onMessage)
    child.on('exit', entry.onExit)
    child.on('error', entry.onError)

    this.workers.set(normalizedSessionId, entry)
    this.startSweep()
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
    timeoutMs?: number | null,
    signal?: AbortSignal,
    input?: unknown,
    description?: string,
    onLog?: (logEntry: ExecJsLogEntry) => void,
  ): Promise<ExecJsDetails> {
    const normalizedSessionId = normalizeSessionId(sessionId)
    this.ensureWorker(normalizedSessionId)

    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      throw new Error(`Failed to create session worker for ${normalizedSessionId}`)
    }
    entry.lastActivityAt = Date.now()

    // null = caller explicitly opts out of any timeout (long-running tasks
    // like a Telegram poller). The worker treats timeoutMs <= 0 as "no timer".
    const { timeoutMs: timeout, wasDefault } = timeoutMs === null
      ? { timeoutMs: 0, wasDefault: false }
      : resolveTimeout(timeoutMs, DEFAULT_EXEC_TIMEOUT_MS)

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
        onLog,
      }

      if (signal) {
        const onAbort = () => {
          this.sendToWorker(entry, {
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

      const sent = this.sendToWorker(entry, {
        type: 'exec:run',
        requestId,
        code,
        timeoutMs: timeout,
        timeoutWasDefault: wasDefault,
        input,
        methods: this.deps.functionRegistry.getMethodNames(),
      } satisfies HostToWorkerMessage)

      if (!sent) {
        return
      }

      if (onLog) {
        this.sendToWorker(entry, {
          type: 'exec:watch',
          requestId,
        } satisfies HostToWorkerMessage)
      }
    })
  }

  disposeAll(): void {
    for (const entry of this.workers.values()) {
      this.disposeEntry(entry, new Error(`Session worker disposed for ${entry.sessionId}`))
    }
    this.stopSweep()
  }

  private startSweep(): void {
    if (this.sweepTimer !== null || this.idleEvictMs <= 0) return
    const timer = setInterval(() => this.sweepIdleWorkers(), this.sweepIntervalMs)
    // Never hold a shutting-down process open just to reap workers.
    ;(timer as { unref?: () => void }).unref?.()
    this.sweepTimer = timer
  }

  private stopSweep(): void {
    if (this.sweepTimer === null) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  private sweepIdleWorkers(): void {
    const now = Date.now()
    for (const entry of [...this.workers.values()]) {
      // An execution in flight means the worker is in use, however long it
      // runs. This is what exempts the long-running task sessions that opt out
      // of timeouts (`timeoutMs === null`) — they hold a pending execution for
      // their whole life, so they are never candidates.
      if (entry.pendingExecutions.size > 0) continue
      if (now - entry.lastActivityAt < this.idleEvictMs) continue

      const idleSec = Math.round((now - entry.lastActivityAt) / 1000)
      // No pending executions, so nothing observes this error — disposeEntry
      // only surfaces it by rejecting them. Eviction is silent by construction.
      this.disposeEntry(
        entry,
        new Error(`Session worker evicted after ${idleSec}s idle for ${entry.sessionId}`),
      )
    }
  }

  private handleWorkerMessage(entry: ChildEntry, message: WorkerToHostMessage): void {
    if (!message || typeof message !== 'object' || typeof (message as unknown as Record<string, unknown>).type !== 'string') {
      return
    }

    // Anything the worker says counts as activity — host calls and log lines
    // included, so a long exec that calls back keeps its own worker alive.
    entry.lastActivityAt = Date.now()

    switch (message.type) {
      case 'exec:result': {
        const pending = entry.pendingExecutions.get(message.requestId)
        if (!pending) {
          return
        }

        entry.pendingExecutions.delete(message.requestId)
        if (pending.onLog) {
          this.sendToWorker(entry, {
            type: 'exec:unwatch',
            requestId: message.requestId,
          } satisfies HostToWorkerMessage)
        }
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
      case 'exec:log': {
        const pending = entry.pendingExecutions.get(message.requestId)
        if (!pending?.onLog) {
          return
        }

        try {
          pending.onLog(message.logEntry)
        } catch (err) {
          console.error('[JsRuntime] exec log listener threw:', err)
        }
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
      this.sendToWorker(entry, {
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: true,
        value,
      } satisfies HostToWorkerMessage)
      // Tracing serializes params and result in full; keep it off the call's
      // critical path so the worker isn't blocked behind it.
      this.safeEmitCallTrace(entry, message, traceStartedAt, value, null)
    } catch (error) {
      this.sendToWorker(entry, {
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: false,
        error: serializeError(error),
      } satisfies HostToWorkerMessage)
      this.safeEmitCallTrace(entry, message, traceStartedAt, undefined, error)
    }
  }

  private sendToWorker(entry: ChildEntry, message: HostToWorkerMessage): boolean {
    if (this.workers.get(entry.sessionId) !== entry) {
      return false
    }

    if (
      !entry.child.connected ||
      entry.child.killed ||
      entry.child.exitCode !== null ||
      entry.child.signalCode !== null
    ) {
      this.disposeEntry(entry, this.createWorkerUnavailableError(entry, message))
      return false
    }

    try {
      entry.child.send(message, (error: Error | null) => {
        if (!error || this.workers.get(entry.sessionId) !== entry) {
          return
        }
        this.disposeEntry(entry, this.createWorkerSendError(entry, message, error))
      })
      return true
    } catch (error) {
      if (this.workers.get(entry.sessionId) === entry) {
        this.disposeEntry(entry, this.createWorkerSendError(entry, message, error))
      }
      return false
    }
  }

  private createWorkerUnavailableError(entry: ChildEntry, message: HostToWorkerMessage): Error {
    let reason = 'IPC channel is closed'
    if (entry.child.exitCode !== null) {
      reason = `process exited with code ${entry.child.exitCode}`
    } else if (entry.child.signalCode !== null) {
      reason = `process exited with signal ${entry.child.signalCode}`
    } else if (entry.child.killed) {
      reason = 'process was killed'
    }

    return new Error(`Failed to send ${message.type} to session worker for ${entry.sessionId}: ${reason}`)
  }

  private createWorkerSendError(entry: ChildEntry, message: HostToWorkerMessage, error: unknown): Error {
    const err = error instanceof Error ? error : new Error(String(error))
    const code = typeof (err as Error & { code?: unknown }).code === 'string'
      ? ` ${(err as Error & { code: string }).code}`
      : ''
    return new Error(`Failed to send ${message.type} to session worker for ${entry.sessionId}:${code} ${err.message}`)
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
      const preview = stringifyCapped((details as { value: unknown }).value, TRACE_RESULT_CAP)
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
    const params = stringifyCapped(message.params, TRACE_PARAMS_CAP)
    const ok = error === null
    let resultPreview: string | null = null
    let resultTruncated = false
    if (ok && value !== undefined) {
      const preview = stringifyCapped(value, TRACE_RESULT_CAP)
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
    // Identity, not presence: a session's worker is now routinely replaced
    // (evict, then respawn on the next execJs), so a stale entry must never
    // take its successor's slot with it. Matches sendToWorker's guard.
    if (this.workers.get(entry.sessionId) !== entry) {
      return
    }

    this.workers.delete(entry.sessionId)

    entry.child.removeListener('message', entry.onMessage)
    entry.child.removeListener('exit', entry.onExit)
    entry.child.removeListener('error', entry.onError)

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

    if (this.workers.size === 0) this.stopSweep()
  }
}
