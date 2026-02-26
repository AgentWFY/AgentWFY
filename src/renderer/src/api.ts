import type { SqlRequestParams } from 'app/api_types'

// in development client is served by vite server, in prod it is server by the main server
const base = import.meta.env.VITE_PUBLIC_API_URL || "/"
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

  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizedRequest)
  }

  const r = await window.fetch(`${base}/sql`, opts)
  const text = await r.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  if (!r.ok) {
    throw new SqlApiError(r.status, body)
  }

  return body
}
