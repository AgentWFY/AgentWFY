import type {
  TaskRunFinishedPayload,
  TaskRunLogPayload,
  TaskRunRead,
  TaskRunStartedPayload,
} from '../../ipc/schema.js'

export interface TasksApi {
  start(taskName: string, input?: unknown, origin?: unknown): Promise<{ runId: string }>
  stop(runId: string): Promise<void>
  listRunning(): Promise<Array<{ runId: string; taskName: string; title: string; status: string; origin: unknown; startedAt: number }>>
  readRun(runId: string): Promise<TaskRunRead>
  listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string; origin?: unknown }>>
  readLog(logFileName: string): Promise<string>
  onRunFinished(callback: (payload: TaskRunFinishedPayload) => void): () => void
  onRunStarted(callback: (payload: TaskRunStartedPayload) => void): () => void
  onRunLog(callback: (payload: TaskRunLogPayload) => void): () => void
  listShortcuts(): Promise<Record<string, string>>
}
