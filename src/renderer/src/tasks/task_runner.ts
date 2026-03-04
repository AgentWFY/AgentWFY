/* eslint-disable import/no-unresolved */
import type { ExecJsLogEntry } from 'app/runtime/types'

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

export class TaskRunner {
  private _runs: TaskRun[] = []
  private listeners = new Set<() => void>()
  private stateChangedUnsub: (() => void) | null = null

  get runs(): TaskRun[] {
    return this._runs
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length
  }

  get runningLabels(): string[] {
    return this._runs.filter(r => r.status === 'running').map(r => r.name)
  }

  async init(): Promise<void> {
    const ipc = window.ipc
    if (!ipc) return

    // Subscribe before fetching to avoid missing state changes between snapshot and subscription
    this.stateChangedUnsub = ipc.tasks.onStateChanged((runs) => {
      this._runs = (runs ?? []) as TaskRun[]
      this.notify()
    })

    // Fetch current state from main process
    try {
      const runs = await ipc.tasks.getRuns()
      this._runs = (runs ?? []) as TaskRun[]
      this.notify()
    } catch {
      // ignore — TaskRunner may not be ready yet
    }
  }

  async startTask(taskId: number): Promise<string> {
    const ipc = window.ipc
    if (!ipc) throw new Error('window.ipc is not available')
    return ipc.tasks.start(taskId)
  }

  async runTask(taskId: number): Promise<string> {
    const ipc = window.ipc
    if (!ipc) throw new Error('window.ipc is not available')
    return ipc.tasks.run(taskId)
  }

  stopTask(runId: string): void {
    const ipc = window.ipc
    if (!ipc) return
    ipc.tasks.stop(runId).catch(err => {
      console.error('[TaskRunner proxy] stopTask failed', err)
    })
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.stateChangedUnsub?.()
    this.stateChangedUnsub = null
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('[TaskRunner proxy] listener error', err)
      }
    }
  }
}

let instance: TaskRunner | null = null

export function getTaskRunner(): TaskRunner | null {
  return instance
}

export function initTaskRunner(): TaskRunner {
  if (!instance) {
    instance = new TaskRunner()
    instance.init().catch(err => {
      console.error('[TaskRunner proxy] init failed', err)
    })
  }
  return instance
}
