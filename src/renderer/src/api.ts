import type { SqlRequestParams } from 'app/api_types'

const DEFAULT_SQL_SENDER = 'client'

export class SqlApiError extends Error {
  status: number
  body: any

  constructor(status: number, body: any) {
    super(typeof body === 'string' ? body : `SQL request failed with status ${status}`)
    this.status = status
    this.body = body
  }
}

export async function sendSqlRequest(request: SqlRequestParams | string) {
  const normalizedRequest: SqlRequestParams = typeof request === 'string'
    ? { sql: request, sender: DEFAULT_SQL_SENDER }
    : { sender: DEFAULT_SQL_SENDER, ...request }

  const tools = window.electronAgentTools
  if (!tools?.runSql) {
    throw new Error('window.electronAgentTools.runSql is not available in this renderer context')
  }

  try {
    return await tools.runSql({
      target: normalizedRequest.target ?? 'agent',
      path: normalizedRequest.path,
      sql: normalizedRequest.sql,
      params: normalizedRequest.params,
      description: normalizedRequest.description,
      confirmed: normalizedRequest.confirmed,
    })
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (message.startsWith('ReadOnlyViolation:')) {
      throw new SqlApiError(422, message)
    }
    throw error
  }
}
