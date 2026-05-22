export interface AgentDbChange {
  table: string
  rowId: string | number
  op: 'insert' | 'update' | 'delete'
}

export interface DbApi {
  onDbChanged(callback: (detail: AgentDbChange) => void): () => void
}
