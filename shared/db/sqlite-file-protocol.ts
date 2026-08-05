// Message shapes exchanged with `sqlite_file_worker.mts`. Kept in their own
// module so the worker and its host agree on the format without either
// importing the other's implementation.

export interface SqliteFileWorkerRequest {
  id: number
  /** Already resolved and security-checked by the host. */
  path: string
  sql: string
  params?: unknown[]
}

export interface SqliteFileWorkerError {
  name: string
  message: string
  stack?: string
  code?: string
}

export type SqliteFileWorkerResponse =
  | { id: number; ok: true; rows: unknown[] }
  | { id: number; ok: false; error: SqliteFileWorkerError }
