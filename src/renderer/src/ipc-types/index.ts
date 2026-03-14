export type { FilesApi } from './files.js'
export type { SqlApi } from './sql.js'
export type { TabsApi, TabViewBounds, MountTabViewRequest, UpdateTabViewBoundsRequest, DestroyTabViewRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent } from './tabs.js'
export type { SessionsApi } from './sessions.js'
export type { AuthApi } from './auth.js'
export type { StoreApi } from './store.js'
export type { DialogApi } from './dialog.js'
export type { BusApi, AgentDbChange } from './bus.js'
export type { TasksApi } from './tasks.js'

import type { FilesApi } from './files.js'
import type { SqlApi } from './sql.js'
import type { TabsApi } from './tabs.js'
import type { SessionsApi } from './sessions.js'
import type { AuthApi } from './auth.js'
import type { StoreApi } from './store.js'
import type { DialogApi } from './dialog.js'
import type { BusApi } from './bus.js'
import type { TasksApi } from './tasks.js'

export interface NetApi {
  headers: {
    set(request: { tid: string; headers: Record<string, string> }): Promise<void>
  }
}

export interface CommandPaletteApi {
  showFiltered(query: string): Promise<void>
}

export interface AppIpc {
  files: FilesApi
  sql: SqlApi
  tabs: TabsApi
  sessions: SessionsApi
  auth: AuthApi
  store: StoreApi
  dialog: DialogApi
  bus: BusApi
  tasks: TasksApi
  net: NetApi
  commandPalette: CommandPaletteApi
  getAgentRoot(): Promise<string | null>
  getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null>
}

declare global {
  interface Window {
    ipc?: AppIpc
  }
}
