export interface TasksApi {
  // Log persistence (IPC to main process)
  listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string; origin?: unknown }>>
  listLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  readLog(logFileName: string): Promise<string>
  writeLog(logFileName: string, content: string): Promise<void>
  // Forwarding handlers for agentview → renderer
  onForwardStartTask(callback: (detail: { waiterId: string; taskId: number; input?: unknown; origin?: unknown }) => void): () => void
  forwardStartTaskResult(waiterId: string, result: unknown): void
  onForwardStopTask(callback: (detail: { waiterId: string; runId: string }) => void): () => void
  forwardStopTaskResult(waiterId: string, result: unknown): void
}
