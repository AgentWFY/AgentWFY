import { parseRunSqlRequest, routeSqlRequest } from '../../db/sql-router.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerSql(registry: FunctionRegistry, deps: { agentRoot: string }): void {
  const { agentRoot } = deps

  registry.register('runSql', async (params) => {
    const request = params as WorkerHostMethodMap['runSql']['params']
    if (!request || typeof request.sql !== 'string' || request.sql.trim().length === 0) {
      throw new Error('runSql requires a non-empty sql string')
    }

    const parsed = parseRunSqlRequest({
      target: request.target ?? 'agent',
      path: request.path,
      sql: request.sql,
      params: request.params,
      description: request.description,
    })
    return await routeSqlRequest(agentRoot, parsed)
  })
}
