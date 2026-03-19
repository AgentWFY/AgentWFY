import type { ExecJsLogEntry, ExecJsDetails } from '../../../runtime/types.js'
import { bus } from '../event-bus.js'

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

export class TaskRunner {
  private _runs: TaskRun[] = []
  private listeners = new Set<() => void>()
  private completionWaiters = new Map<string, { resolve: (value: unknown) => void }>()
  private logUnsubscribe: (() => void) | null = null

  get runs(): TaskRun[] {
    return this._runs
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length
  }

  async startTask(taskId: number, input?: unknown, origin?: TaskOrigin): Promise<string> {
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
      origin: origin ?? { type: 'task-panel' },
      input,
      startedAt: Date.now(),
      logs: [],
    }

    this._runs.unshift(run)
    this.notify()

    await ipc.execJs.ensureWorker(runId)

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

    void window.ipc?.execJs.terminateWorker(runId)

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
      const items = await ipc.tasks.listLogHistory()
      return items as TaskLogHistoryItem[]
    } catch {
      return []
    }
  }

  watchRun(runId: string): void {
    const run = this._runs.find(r => r.runId === runId && r.status === 'running')
    if (!run) return

    run.logs = []

    const ipc = window.ipc
    if (!ipc) return

    // Subscribe to log events for this run
    if (!this.logUnsubscribe) {
      this.logUnsubscribe = ipc.execJs.onLog((sessionId, entry) => {
        const targetRun = this._runs.find(r => r.runId === sessionId && r.status === 'running')
        if (targetRun) {
          targetRun.logs.push(entry as ExecJsLogEntry)
        }
      })
    }

    void ipc.execJs.watchLogs(runId)
  }

  unwatchRun(runId: string): void {
    void window.ipc?.execJs.unwatchLogs(runId)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const run of this._runs) {
      if (run.status === 'running') {
        void window.ipc?.execJs.terminateWorker(run.runId)
      }
    }
    this._runs = []
    this.completionWaiters.clear()
    this.listeners.clear()
    if (this.logUnsubscribe) {
      this.logUnsubscribe()
      this.logUnsubscribe = null
    }
  }

  private async executeRun(run: TaskRun, code: string, timeoutMs: number, input?: unknown): Promise<void> {
    const ipc = window.ipc
    if (!ipc) {
      run.status = 'failed'
      run.error = 'window.ipc is not available'
      run.finishedAt = Date.now()
      this.notify()
      return
    }

    try {
      const details = await ipc.execJs.execute(run.runId, code, timeoutMs, input) as ExecJsDetails

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
        void ipc?.execJs.terminateWorker(run.runId)
        await this.persistLog(run)
        this.notify()
      }
      this.removeFinishedRun(run.runId)

      // Always publish bus event and resolve completion waiters
      bus.publish(`task:run:${run.runId}`, {
        runId: run.runId, taskId: run.taskId, name: run.name,
        status: run.status, origin: run.origin, startedAt: run.startedAt,
        finishedAt: run.finishedAt, result: run.result, error: run.error, logs: run.logs,
      })

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
      const ipc = window.ipc
      if (!ipc) return

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
