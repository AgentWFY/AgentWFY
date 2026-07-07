import crypto from 'crypto'
import type { ExecJsLogEntry, ExecJsDetails } from '../runtime/types.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import type { FileStore } from '../storage/file-store.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import { escapeRegex, makeSnippet } from '../runtime/functions/text_utils.js'
import { TASK_LOGS_RELATIVE_DIR, TASK_LOG_FILE_NAME_RE } from '../backend/task-logs.js'

// Public task types live in the node-free ./task_types.ts so type-only
// consumers don't have to resolve this node-bound module. Re-exported here so
// existing `from './task_runner.js'` importers are unaffected.
export type {
  TaskOrigin,
  TaskRunStatus,
  TaskRunStartedPayload,
  TaskRunFinishedPayload,
  TaskRunLogPayload,
  TaskRunRead,
} from './task_types.js'
import type {
  TaskOrigin,
  TaskRunStatus,
  TaskRunStartedPayload,
  TaskRunFinishedPayload,
  TaskRunLogPayload,
  TaskRunRead,
} from './task_types.js'

const PRIVATE = { allowPrivate: true } as const

interface TaskRun {
  runId: string
  taskName: string
  title: string
  status: TaskRunStatus
  origin: TaskOrigin
  input?: unknown
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  logs: ExecJsLogEntry[]
}

export interface TaskRunSummary {
  runId: string
  taskName: string
  title: string
  status: TaskRunStatus
  origin: TaskOrigin
  startedAt: number
  finishedAt?: number
}

export interface TaskRunMatchEntry {
  where: 'log' | 'result' | 'error' | 'input'
  logIndex?: number
  snippet: string
}

export interface TaskRunMatch {
  runId: string
  taskName: string
  status: TaskRunStatus
  startedAt: number
  matches: TaskRunMatchEntry[]
}

export interface ListTaskRunsRequest {
  limit?: number
  offset?: number
  since?: number
  until?: number
  status?: TaskRunStatus
}

export interface SearchTaskRunsRequest {
  pattern: string
  ignoreCase?: boolean
  literal?: boolean
  limit?: number
  matchesPerRun?: number
  since?: number
  until?: number
}

interface ParsedTaskLog {
  runId: string
  taskName: string
  title: string
  status: TaskRunStatus
  origin: TaskOrigin
  input: unknown
  startedAt: number
  finishedAt: number | null
  result: unknown
  error: string | null
  logs: ExecJsLogEntry[]
}

function createRunId(taskName: string): string {
  return `task-${taskName}-${crypto.randomUUID()}`
}

function createLogFileName(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}.json`
}

interface TaskRunnerDeps {
  runtimeRoot: string
  store: FileStore
  getJsRuntime: () => JsRuntime
  busPublish: (topic: string, data: unknown) => void
}

export interface TaskLifecycleListener {
  onRunStarted?: (payload: TaskRunStartedPayload) => void
  onRunLog?: (payload: TaskRunLogPayload) => void
  onRunFinished?: (payload: TaskRunFinishedPayload) => void
}

export class TaskRunner {
  private _runs: TaskRun[] = []
  private readonly deps: TaskRunnerDeps
  private readonly lifecycleListeners = new Set<TaskLifecycleListener>()

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps
  }

  subscribeLifecycle(listener: TaskLifecycleListener): () => void {
    this.lifecycleListeners.add(listener)
    return () => {
      this.lifecycleListeners.delete(listener)
    }
  }

  private emitLifecycle<K extends keyof TaskLifecycleListener>(
    method: K,
    payload: Parameters<NonNullable<TaskLifecycleListener[K]>>[0],
  ): void {
    for (const listener of this.lifecycleListeners) {
      const fn = listener[method]
      if (!fn) continue
      try {
        ;(fn as (p: typeof payload) => void)(payload)
      } catch (err) {
        console.error(`[TaskRunner] ${method} listener threw:`, err)
      }
    }
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length
  }

  listRunning(): Array<{ runId: string; taskName: string; title: string; status: string; origin: TaskOrigin; startedAt: number }> {
    return this._runs
      .filter(r => r.status === 'running')
      .map(r => ({ runId: r.runId, taskName: r.taskName, title: r.title, status: r.status, origin: r.origin, startedAt: r.startedAt }))
  }

  async startTask(taskName: string, input?: unknown, origin?: TaskOrigin): Promise<string> {
    const { runtimeRoot, getJsRuntime } = this.deps

    const parsed = parseRunSqlRequest({
      target: 'agent',
      sql: 'SELECT name, title, content, timeout_ms FROM tasks WHERE name = ? LIMIT 1',
      params: [taskName],
    })
    const rows = await routeSqlRequest(runtimeRoot, parsed) as Array<{ name: string; title: string; content: string; timeout_ms: number | null }>

    if (!rows || rows.length === 0) {
      throw new Error(`Task ${taskName} not found`)
    }

    const task = rows[0]
    const runId = createRunId(taskName)
    // null = run forever (no timeout) — used for long-running tasks like a
    // Telegram long-poller. A positive number caps the run at that many ms.
    const timeoutMs: number | null = typeof task.timeout_ms === 'number' && task.timeout_ms > 0
      ? task.timeout_ms
      : null

    const run: TaskRun = {
      runId,
      taskName,
      title: task.title,
      status: 'running',
      origin: origin ?? { type: 'task-panel' },
      input,
      startedAt: Date.now(),
      logs: [],
    }

    this._runs.unshift(run)

    this.emitLifecycle('onRunStarted', {
      runId: run.runId, taskName: run.taskName, title: run.title,
      status: run.status, origin: run.origin, startedAt: run.startedAt,
    })

    const runtime = getJsRuntime()
    runtime.ensureWorker(runId)

    void this.executeRun(run, task.content, timeoutMs, input)

    return runId
  }

  stopTask(runId: string): void {
    const run = this._runs.find(r => r.runId === runId)
    if (!run || run.status !== 'running') return

    this.deps.getJsRuntime().terminateWorker(runId)

    run.status = 'failed'
    run.error = 'Stopped by user'
    run.finishedAt = Date.now()
    void this.persistLog(run)
  }

  dispose(): void {
    const runtime = this.deps.getJsRuntime()
    for (const run of this._runs) {
      if (run.status === 'running') {
        runtime.terminateWorker(run.runId)
      }
    }
    this._runs = []
    this.lifecycleListeners.clear()
  }

  async listTaskRuns(request: ListTaskRunsRequest = {}): Promise<TaskRunSummary[]> {
    const limit = request.limit ?? 20
    const offset = request.offset ?? 0
    if (!Number.isFinite(limit) || limit < 1) throw new Error('listTaskRuns limit must be >= 1')
    if (!Number.isFinite(offset) || offset < 0) throw new Error('listTaskRuns offset must be >= 0')

    const status = request.status
    const inTimeWindow = (t: number) => {
      if (request.since !== undefined && t < request.since) return false
      if (request.until !== undefined && t > request.until) return false
      return true
    }

    const running: TaskRunSummary[] = (!status || status === 'running')
      ? this._runs
          .filter(r => r.status === 'running' && inTimeWindow(r.startedAt))
          .map(r => ({
            runId: r.runId,
            taskName: r.taskName,
            title: r.title,
            status: r.status,
            origin: r.origin,
            startedAt: r.startedAt,
          }))
      : []

    let persisted: TaskRunSummary[] = []
    if (status !== 'running') {
      const files = (await listTaskLogFiles(this.deps.store)).filter(f => inTimeWindow(f.mtimeMs))
      // mtime ordering closely matches finishedAt — parse only enough to fill
      // the requested page (plus a buffer for running-run interleaving).
      const candidates = files.slice(0, offset + limit + running.length)
      const parsed = await Promise.all(candidates.map(f => readParsedLog(this.deps.store, f.name)))
      for (const p of parsed) {
        if (!p) continue
        if (status && p.status !== status) continue
        persisted.push({
          runId: p.runId,
          taskName: p.taskName,
          title: p.title,
          status: p.status,
          origin: p.origin,
          startedAt: p.startedAt,
          ...(p.finishedAt !== null ? { finishedAt: p.finishedAt } : {}),
        })
      }
    }

    const merged = [...running, ...persisted]
    merged.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    return merged.slice(offset, offset + limit)
  }

  async searchTaskRuns(request: SearchTaskRunsRequest): Promise<TaskRunMatch[]> {
    const limit = request.limit ?? 10
    const matchesPerRun = request.matchesPerRun ?? 5
    if (!Number.isFinite(limit) || limit < 1) throw new Error('searchTaskRuns limit must be >= 1')
    if (!Number.isFinite(matchesPerRun) || matchesPerRun < 1) {
      throw new Error('searchTaskRuns matchesPerRun must be >= 1')
    }

    const source = request.literal ? escapeRegex(request.pattern) : request.pattern
    let regex: RegExp
    try {
      regex = new RegExp(source, request.ignoreCase ? 'i' : '')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid regex: ${msg}`)
    }

    const runningMatches: TaskRunMatch[] = []
    for (const run of this._runs) {
      if (run.status !== 'running') continue
      if (request.since !== undefined && run.startedAt < request.since) continue
      if (request.until !== undefined && run.startedAt > request.until) continue
      const matches = matchRunFields({
        input: run.input,
        result: undefined,
        error: undefined,
        logs: run.logs,
      }, regex, matchesPerRun)
      if (matches.length > 0) {
        runningMatches.push({
          runId: run.runId,
          taskName: run.taskName,
          status: run.status,
          startedAt: run.startedAt,
          matches,
        })
      }
    }

    const files = (await listTaskLogFiles(this.deps.store)).filter(f => {
      if (request.since !== undefined && f.mtimeMs < request.since) return false
      if (request.until !== undefined && f.mtimeMs > request.until) return false
      return true
    })

    const parsedLogs = await Promise.all(files.map(f => readParsedLog(this.deps.store, f.name)))
    const persistedMatches: TaskRunMatch[] = []
    for (const parsed of parsedLogs) {
      if (!parsed) continue
      if (runningMatches.length + persistedMatches.length >= limit) break
      const matches = matchRunFields({
        input: parsed.input,
        result: parsed.result,
        error: parsed.error,
        logs: parsed.logs,
      }, regex, matchesPerRun)
      if (matches.length === 0) continue
      persistedMatches.push({
        runId: parsed.runId,
        taskName: parsed.taskName,
        status: parsed.status,
        startedAt: parsed.startedAt,
        matches,
      })
    }

    return [...runningMatches, ...persistedMatches].slice(0, limit)
  }

  async readTaskRun(runId: string): Promise<TaskRunRead> {
    const live = this._runs.find(r => r.runId === runId)
    if (live) {
      return {
        runId: live.runId,
        taskName: live.taskName,
        title: live.title,
        status: live.status,
        origin: live.origin,
        input: live.input ?? null,
        startedAt: live.startedAt,
        finishedAt: live.finishedAt ?? null,
        result: live.result ?? null,
        error: live.error ?? null,
        logs: live.logs,
      }
    }

    const files = await listTaskLogFiles(this.deps.store)
    const parsedLogs = await Promise.all(files.map(f => readParsedLog(this.deps.store, f.name)))
    const match = parsedLogs.find((p): p is ParsedTaskLog => p !== null && p.runId === runId)
    if (match) {
      return {
        runId: match.runId,
        taskName: match.taskName,
        title: match.title,
        status: match.status,
        origin: match.origin,
        input: match.input,
        startedAt: match.startedAt,
        finishedAt: match.finishedAt,
        result: match.result,
        error: match.error,
        logs: match.logs,
      }
    }
    throw new Error(`Task run '${runId}' not found`)
  }

  private async executeRun(run: TaskRun, code: string, timeoutMs: number | null, input?: unknown): Promise<void> {
    const runtime = this.deps.getJsRuntime()

    try {
      const details = await runtime.executeExecJs(run.runId, code, timeoutMs, undefined, input, undefined, (log) => {
        const logIndex = run.logs.push(log) - 1
        const payload: TaskRunLogPayload = {
          runId: run.runId,
          taskName: run.taskName,
          title: run.title,
          status: run.status,
          origin: run.origin,
          startedAt: run.startedAt,
          log,
          logIndex,
        }
        this.deps.busPublish(`task:run:${run.runId}:log`, payload)
        this.emitLifecycle('onRunLog', payload)
      }) as ExecJsDetails

      run.logs = details.logs ?? []

      if (details.ok) {
        run.status = 'completed'
        run.result = details.value
      } else {
        run.status = 'failed'
        const msg = details.error?.message ?? 'Unknown error'
        run.error = details.error?.stack ? `${msg}\n${details.error.stack}` : msg
      }
    } catch (err) {
      // Don't overwrite status/error if stopTask already finalized this run
      if (!run.finishedAt) {
        run.status = 'failed'
        run.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      let logFile: string | null = null
      const alreadyFinished = !!run.finishedAt
      if (!alreadyFinished) {
        run.finishedAt = Date.now()
        runtime.terminateWorker(run.runId)
        logFile = await this.persistLog(run)
      }
      this.removeFinishedRun(run.runId)

      const payload = {
        runId: run.runId, taskName: run.taskName, title: run.title,
        status: run.status, origin: run.origin, startedAt: run.startedAt,
        finishedAt: run.finishedAt, result: run.result, error: run.error, logs: run.logs,
        logFile,
      }
      this.deps.busPublish(`task:run:${run.runId}`, payload)
      this.emitLifecycle('onRunFinished', payload)
    }
  }

  private removeFinishedRun(runId: string): void {
    const idx = this._runs.findIndex(r => r.runId === runId)
    if (idx !== -1 && this._runs[idx].status !== 'running') {
      this._runs.splice(idx, 1)
    }
  }

  private async persistLog(run: TaskRun): Promise<string | null> {
    try {
      const logFileName = createLogFileName()
      const logData = {
        runId: run.runId,
        taskName: run.taskName,
        taskTitle: run.title,
        status: run.status,
        origin: run.origin,
        input: run.input ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result ?? null,
        error: run.error ?? null,
        logs: run.logs,
      }

      await this.deps.store.writeText(`${TASK_LOGS_RELATIVE_DIR}/${logFileName}`, JSON.stringify(logData, null, 2), PRIVATE)
      return logFileName
    } catch (err) {
      console.error('[TaskRunner] failed to persist log', err)
      return null
    }
  }
}

async function listTaskLogFiles(store: FileStore): Promise<Array<{ name: string; mtimeMs: number }>> {
  const entries = await store.list(TASK_LOGS_RELATIVE_DIR, PRIVATE)
  return entries
    .filter(e => !e.isDirectory && TASK_LOG_FILE_NAME_RE.test(e.name))
    .map(e => ({ name: e.name, mtimeMs: e.mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function coerceStatus(value: unknown): TaskRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' ? value : 'failed'
}

async function readParsedLog(store: FileStore, file: string): Promise<ParsedTaskLog | null> {
  try {
    const raw = await store.readText(`${TASK_LOGS_RELATIVE_DIR}/${file}`, PRIVATE)
    const parsed = JSON.parse(raw)
    if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) return null
    return {
      runId: parsed.runId,
      taskName: typeof parsed.taskName === 'string' ? parsed.taskName : 'unknown',
      title: typeof parsed.taskTitle === 'string' ? parsed.taskTitle : (typeof parsed.taskName === 'string' ? parsed.taskName : 'unknown'),
      status: coerceStatus(parsed.status),
      origin: parsed.origin ?? { type: 'task-panel' },
      input: parsed.input ?? null,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
      result: parsed.result ?? null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    }
  } catch {
    return null
  }
}

function stringifyForSearch(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function matchRunFields(
  fields: { input: unknown; result: unknown; error: string | null | undefined; logs: ExecJsLogEntry[] },
  regex: RegExp,
  matchesPerRun: number,
): TaskRunMatchEntry[] {
  const out: TaskRunMatchEntry[] = []

  const inputText = stringifyForSearch(fields.input)
  if (inputText) {
    const m = regex.exec(inputText)
    if (m) out.push({ where: 'input', snippet: makeSnippet(inputText, m.index, m[0].length) })
  }
  if (out.length >= matchesPerRun) return out

  const resultText = stringifyForSearch(fields.result)
  if (resultText) {
    const m = regex.exec(resultText)
    if (m) out.push({ where: 'result', snippet: makeSnippet(resultText, m.index, m[0].length) })
  }
  if (out.length >= matchesPerRun) return out

  if (fields.error) {
    const m = regex.exec(fields.error)
    if (m) out.push({ where: 'error', snippet: makeSnippet(fields.error, m.index, m[0].length) })
  }
  if (out.length >= matchesPerRun) return out

  for (let i = 0; i < fields.logs.length; i++) {
    if (out.length >= matchesPerRun) break
    const text = fields.logs[i].message
    if (!text) continue
    const m = regex.exec(text)
    if (!m) continue
    out.push({ where: 'log', logIndex: i, snippet: makeSnippet(text, m.index, m[0].length) })
  }

  return out
}
