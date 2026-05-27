import type { AgentDbChange } from '../ipc-types/index.js'
import { dispatch } from '../events.js'

class DbEventsService {
  private unlistenDbChanged: (() => void) | null = null

  install(): void {
    this.destroy()
    const ipc = window.ipc
    if (!ipc?.db) return

    this.unlistenDbChanged = ipc.db.onDbChanged((change: AgentDbChange) => {
      if (!change) return
      if (change.op !== 'insert' && change.op !== 'update' && change.op !== 'delete') return
      if (change.rowId == null) return

      if (change.table === 'views') {
        dispatch('views-db-changed', { change })
      }
      if (change.table === 'tasks') {
        dispatch('tasks-db-changed')
      }
      if (change.table === 'triggers') {
        dispatch('triggers-db-changed')
      }
      if (change.table === 'config') {
        dispatch('config-db-changed', { key: String(change.rowId) })
      }
    })
  }

  destroy(): void {
    this.unlistenDbChanged?.()
    this.unlistenDbChanged = null
  }
}

export const dbEvents = new DbEventsService()
