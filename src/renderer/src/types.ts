import type { SqlTarget } from 'app/api_types'

export interface PendingSqlConfirmation {
  requestId: string
  target?: SqlTarget
  path?: string
  sql: string
  params?: any[]
  description?: string
  sender: string
}

export type TabDataTypes = 'external-view'
export interface TabData {
  id: string
  dataType: TabDataTypes
  title: string
  viewId: string | number | null
  viewUpdatedAt?: number | null
  viewChanged: boolean
  pinned: boolean
}
