import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { BrowserWindow } from 'electron'
import type { ExecJsLogEntry, ExecJsDetails } from '../runtime/types.js'
import type { JsRuntime } from '../runtime/js_runtime.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import { forwardBusPublish } from '../ipc/bus.js'

export type TaskOrigin =
  | { type: 'command-palette' }
  | { type: 'task-panel' }
  | { type: 'agent' }
  | { type: 'trigger'; triggerId: number; triggerType: 'schedule' | 'http' | 'event'; triggerConfig?: string }
  | { type: 'view' }

export interface TaskRun {
  runId: string
  taskId: number
  name: string
  status: 'running' | 'completed' | 'failed'
  origin: TaskOrigin
  input?: unknown
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  logs: ExecJsLogEntry[]
  logFile?: string
}

export interface TaskLogHistoryItem {
  file: string
  updatedAt: number
  taskName: string
  status: string
  origin?: TaskOrigin
}

function createRunId(taskId: number): string {
  return `task-${taskId}-${crypto.randomUUID()}`
}

function createLogFileName(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}.json`
}

export interface TaskRunnerDeps {
  agentRoot: string
  win: BrowserWindow
  getJsRuntime: () => JsRuntime
}

export class TaskRunner {
  private _runs: TaskRun[] = []
  private listeners = new Set<() => void>()
  private completionWaiters = new Map<string, { resolve: (value: unknown) => void }>()
  private readonly deps: TaskRunnerDeps

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps
  }

  get runs(): TaskRun[] {
    return this._runs
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length
  }

  async startTask(taskId: number, input?: unknown, origin?: TaskOrigin): Promise<string> {
    const { agentRoot, getJsRuntime } = this.deps

    const parsed = parseRunSqlRequest({
      target: 'agent',
      sql: 'SELECT id, name, content, timeout_ms FROM tasks WHERE id = ? LIMIT 1',
      params: [taskId],
    })
    const rows = await routeSqlRequest(agentRoot, parsed) as Array<{ id: number; name: string; content: string; timeout_ms: number | null }>

    if (!rows || rows.length === 0) {
      throw new Error(`Task ${taskId} not found`)
    }

    const task = rows[0]
    const runId = createRunId(taskId)
    const timeoutMs = typeof task.timeout_ms === 'number' && task.timeout_ms > 0
      ? task.timeout_ms
      : 0

    const run: TaskRun = {
      runId,
      taskId,
      name: task.name,
      status: 'running',
      origin: origin ?? { type: 'task-panel' },
      input,
      startedAt: Date.now(),
      logs: [],
    }

    this._runs.unshift(run)
    this.notify()

    const runtime = getJsRuntime()
    runtime.ensureWorker(runId)

    void this.executeRun(run, task.content, timeoutMs, input)

    return runId
  }

  async runTask(taskId: number, input?: unknown, origin?: TaskOrigin): Promise<string> {
    const runId = await this.startTask(taskId, input, origin)
    await new Promise<unknown>((resolve) => {
      this.completionWaiters.set(runId, { resolve })
    })
    return runId
  }

  stopTask(runId: string): void {
    const run = this._runs.find(r => r.runId === runId)
    if (!run || run.status !== 'running') return

    this.deps.getJsRuntime().terminateWorker(runId)

    run.status = 'failed'
    run.error = 'Stopped by user'
    run.finishedAt = Date.now()
    this.notify()
    void this.persistLog(run)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    const runtime = this.deps.getJsRuntime()
    for (const run of this._runs) {
      if (run.status === 'running') {
        runtime.terminateWorker(run.runId)
      }
    }
    this._runs = []
    this.completionWaiters.clear()
    this.listeners.clear()
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
        run.error = details.error?.message ?? 'Unknown error'
      }
    } catch (err) {
      // Don't overwrite status/error if stopTask already finalized this run
      if (!run.finishedAt) {
        run.status = 'failed'
        run.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      const alreadyFinished = !!run.finishedAt
      if (!alreadyFinished) {
        run.finishedAt = Date.now()
        runtime.terminateWorker(run.runId)
        await this.persistLog(run)
        this.notify()
      }
      this.removeFinishedRun(run.runId)

      // Always publish bus event and resolve completion waiters
      if (!this.deps.win.isDestroyed()) {
        forwardBusPublish(this.deps.win, `task:run:${run.runId}`, {
          runId: run.runId, taskId: run.taskId, name: run.name,
          status: run.status, origin: run.origin, startedAt: run.startedAt,
          finishedAt: run.finishedAt, result: run.result, error: run.error, logs: run.logs,
        })
      }

      const waiter = this.completionWaiters.get(run.runId)
      if (waiter) {
        this.completionWaiters.delete(run.runId)
        waiter.resolve(undefined)
      }
    }
  }

  private removeFinishedRun(runId: string): void {
    const idx = this._runs.findIndex(r => r.runId === runId)
    if (idx !== -1 && this._runs[idx].status !== 'running') {
      this._runs.splice(idx, 1)
      this.notify()
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[TaskRunner] listener error', err)
      }
    }
  }

  private async persistLog(run: TaskRun): Promise<void> {
    try {
      const taskLogsDir = path.join(this.deps.agentRoot, '.agentwfy', 'task_logs')
      await fs.mkdir(taskLogsDir, { recursive: true })

      const logFileName = createLogFileName()
      const logData = {
        taskId: run.taskId,
        taskName: run.name,
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
      run.logFile = logFileName
    } catch (err) {
      console.error('[TaskRunner] failed to persist log', err)
    }
  }
}
