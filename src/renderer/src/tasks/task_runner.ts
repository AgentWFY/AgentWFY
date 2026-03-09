import type { ExecJsLogEntry } from '../runtime/types.js'
import { getJsRuntime } from '../runtime/js_runtime.js'
import { bus } from '../event-bus.js'

export interface TaskRun {
  runId: string
  taskId: number
  name: string
  status: 'running' | 'completed' | 'failed'
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
}

function createRunId(taskId: number): string {
  return `task-${taskId}-${crypto.randomUUID()}`
}

function createLogFileName(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}.json`
}

export class TaskRunner {
  private _runs: TaskRun[] = []
  private listeners = new Set<() => void>()
  private completionWaiters = new Map<string, { resolve: (value: unknown) => void }>()

  get runs(): TaskRun[] {
    return this._runs
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length
  }

  get runningLabels(): string[] {
    return this._runs.filter(r => r.status === 'running').map(r => r.name)
  }

  async startTask(taskId: number): Promise<string> {
    const ipc = window.ipc
    if (!ipc) throw new Error('window.ipc is not available')

    const rows = await ipc.sql.run({
      target: 'agent',
      sql: 'SELECT id, name, content, timeout_ms FROM tasks WHERE id = ? LIMIT 1',
      params: [taskId],
    }) as Array<{ id: number; name: string; content: string; timeout_ms: number | null }>

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
      startedAt: Date.now(),
      logs: [],
    }

    this._runs.unshift(run)
    this.notify()

    const runtime = getJsRuntime()
    runtime.ensureWorker(runId)

    void this.executeRun(run, task.content, timeoutMs)

    return runId
  }

  async runTask(taskId: number): Promise<string> {
    const runId = await this.startTask(taskId)
    await new Promise<unknown>((resolve) => {
      this.completionWaiters.set(runId, { resolve })
    })
    return runId
  }

  stopTask(runId: string): void {
    const run = this._runs.find(r => r.runId === runId)
    if (!run || run.status !== 'running') return

    const runtime = getJsRuntime()
    runtime.terminateWorker(runId)

    run.status = 'failed'
    run.error = 'Stopped by user'
    run.finishedAt = Date.now()
    this.notify()
    void this.persistLog(run)
  }

  async listLogHistory(): Promise<TaskLogHistoryItem[]> {
    const ipc = window.ipc
    if (!ipc) return []

    try {
      return await ipc.tasks.listLogHistory()
    } catch {
      return []
    }
  }

  watchRun(runId: string): void {
    const run = this._runs.find(r => r.runId === runId && r.status === 'running')
    if (!run) return

    run.logs = []
    const runtime = getJsRuntime()
    runtime.watchLogs(runId, (entry) => {
      run.logs.push(entry)
    })
  }

  unwatchRun(runId: string): void {
    const runtime = getJsRuntime()
    runtime.unwatchLogs(runId)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    const runtime = getJsRuntime()
    for (const run of this._runs) {
      if (run.status === 'running') {
        runtime.terminateWorker(run.runId)
      }
    }
    this._runs = []
    this.completionWaiters.clear()
    this.listeners.clear()
  }

  private async executeRun(run: TaskRun, code: string, timeoutMs: number): Promise<void> {
    const runtime = getJsRuntime()

    try {
      const details = await runtime.executeExecJs(run.runId, code, timeoutMs)

      run.logs = details.logs ?? []

      if (details.ok) {
        run.status = 'completed'
        run.result = details.value
      } else {
        run.status = 'failed'
        run.error = details.error?.message ?? 'Unknown error'
      }
    } catch (err) {
      run.status = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
    } finally {
      run.finishedAt = Date.now()
      runtime.terminateWorker(run.runId)
      this.notify()
      void this.persistLog(run)

      // Publish to bus so code that calls waitFor('task:run:...') still works
      bus.publish(`task:run:${run.runId}`, {
        runId: run.runId, taskId: run.taskId, name: run.name,
        status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
        result: run.result, error: run.error, logs: run.logs,
      })

      // Resolve internal completion waiters
      const waiter = this.completionWaiters.get(run.runId)
      if (waiter) {
        this.completionWaiters.delete(run.runId)
        waiter.resolve(undefined)
      }
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
      const ipc = window.ipc
      if (!ipc) return

      const logFileName = createLogFileName()
      const logData = {
        taskId: run.taskId,
        taskName: run.name,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result ?? null,
        error: run.error ?? null,
        logs: run.logs,
      }

      await ipc.tasks.writeLog(logFileName, JSON.stringify(logData, null, 2))
      run.logFile = logFileName
    } catch (err) {
      console.error('[TaskRunner] failed to persist log', err)
    }
  }
}

let instance: TaskRunner | null = null

export function getTaskRunner(): TaskRunner | null {
  return instance
}

export function initTaskRunner(): TaskRunner {
  if (instance) {
    instance.dispose()
  }
  instance = new TaskRunner()
  return instance
}
