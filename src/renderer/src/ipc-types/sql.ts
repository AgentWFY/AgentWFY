import type { WorkerRunSqlRequest } from '../runtime/types'

export interface SqlApi {
  run(request: WorkerRunSqlRequest): Promise<unknown>
}
