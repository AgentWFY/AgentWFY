import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { ExecJsLogEntry, ExecJsDetails } from '../runtime/types.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'

export type TaskOrigin =
  | { type: 'command-palette' }
  | { type: 'task-panel' }
  | { type: 'agent' }
  | { type: 'trigger'; triggerName: string; triggerType: 'schedule' | 'http' | 'event'; triggerConfig?: string }
  | { type: 'view' }

interface TaskRun {
  runId: string
  taskName: string
  title: string
  status: 'running' | 'completed' | 'failed'
  origin: TaskOrigin
  input?: unknown
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
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
  agentRoot: string
  getJsRuntime: () => JsRuntime
  busPublish: (topic: string, data: unknown) => void
  onRunFinished?: (payload: unknown) => void
  onRunStarted?: (payload: unknown) => void
}

export class TaskRunner {
  private _runs: TaskRun[] = []
  private readonly deps: TaskRunnerDeps

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps
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
    const { agentRoot, getJsRuntime } = this.deps

    const parsed = parseRunSqlRequest({
      target: 'agent',
      sql: 'SELECT name, title, content, timeout_ms FROM tasks WHERE name = ? LIMIT 1',
      params: [taskName],
    })
    const rows = await routeSqlRequest(agentRoot, parsed) as Array<{ name: string; title: string; content: string; timeout_ms: number | null }>

    if (!rows || rows.length === 0) {
      throw new Error(`Task ${taskName} not found`)
    }

    const task = rows[0]
    const runId = createRunId(taskName)
    const timeoutMs = typeof task.timeout_ms === 'number' && task.timeout_ms > 0
      ? task.timeout_ms
      : 0

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

    this.deps.onRunStarted?.({
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
  }

  private async executeRun(run: TaskRun, code: string, timeoutMs: number, input?: unknown): Promise<void> {
    const runtime = this.deps.getJsRuntime()

    try {
      const details = await runtime.executeExecJs(run.runId, code, timeoutMs, undefined, input) as ExecJsDetails

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
      this.deps.onRunFinished?.(payload)
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
      const taskLogsDir = path.join(this.deps.agentRoot, '.agentwfy', 'task_logs')
      await fs.mkdir(taskLogsDir, { recursive: true })

      const logFileName = createLogFileName()
      const logData = {
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

      const logPath = path.join(taskLogsDir, logFileName)
      await fs.writeFile(logPath, JSON.stringify(logData, null, 2), 'utf-8')
      return logFileName
    } catch (err) {
      console.error('[TaskRunner] failed to persist log', err)
      return null
    }
  }
}
