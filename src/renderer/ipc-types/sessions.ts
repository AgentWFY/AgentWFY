export interface SessionsApi {
  list(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>
  read(sessionFileName: string): Promise<string>
  write(sessionFileName: string, content: string): Promise<void>
}
