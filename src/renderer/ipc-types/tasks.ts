export interface TasksApi {
  // Direct task execution
  start(taskName: string, input?: unknown, origin?: unknown): Promise<{ runId: string }>
  stop(runId: string): Promise<void>
  listRunning(): Promise<Array<{ runId: string; taskName: string; title: string; status: string; origin: unknown; startedAt: number }>>
  // Log persistence (IPC to main process)
  listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string; origin?: unknown }>>
  listLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readLog(logFileName: string): Promise<string>
  writeLog(logFileName: string, content: string): Promise<void>
  onRunFinished(callback: (payload: unknown) => void): () => void
  onRunStarted(callback: (payload: unknown) => void): () => void
}
