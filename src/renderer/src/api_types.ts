/**
 * Run SQL request types
 */

export type SqlTarget = 'agent' | 'sqlite-file'

export interface SqlRequestParams {
  target?: SqlTarget
  path?: string
  sql: string
  params?: any[]
  description?: string
  sender: string
  confirmed?: boolean
}
