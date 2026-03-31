import type { WorkerRunSqlRequest } from '../../runtime/types.js'

export interface SqlApi {
  run(request: WorkerRunSqlRequest): Promise<unknown>
}
