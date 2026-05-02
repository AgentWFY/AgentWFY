import type { TaskRunFinishedPayload, TaskRunStartedPayload } from '../../ipc/schema.js'

export interface TasksApi {
  start(taskName: string, input?: unknown, origin?: unknown): Promise<{ runId: string }>
  stop(runId: string): Promise<void>
  listRunning(): Promise<Array<{ runId: string; taskName: string; title: string; status: string; origin: unknown; startedAt: number }>>
  listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string; origin?: unknown }>>
  listLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readLog(logFileName: string): Promise<string>
  writeLog(logFileName: string, content: string): Promise<void>
  onRunFinished(callback: (payload: TaskRunFinishedPayload) => void): () => void
  onRunStarted(callback: (payload: TaskRunStartedPayload) => void): () => void
  listShortcuts(): Promise<Record<string, string>>
}
