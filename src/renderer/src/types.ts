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
