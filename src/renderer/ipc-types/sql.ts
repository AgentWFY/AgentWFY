import type { WorkerRunSqlRequest } from '#shared/runtime/types.js'

export interface SqlApi {
  run(request: WorkerRunSqlRequest): Promise<unknown>
}
