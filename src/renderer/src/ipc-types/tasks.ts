import type { WorkerStartTaskResult } from '../runtime/types'

export interface TasksApi {
  // Agent tool operations
  start(taskId: number): Promise<WorkerStartTaskResult>
  stop(runId: string): Promise<void>
  // App only
  run(taskId: number): Promise<string>
  getRuns(): Promise<unknown[]>
  listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string }>>
  onStateChanged(callback: (runs: unknown[]) => void): () => void
  listLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readLog(logFileName: string): Promise<string>
  writeLog(logFileName: string, content: string): Promise<void>
}
