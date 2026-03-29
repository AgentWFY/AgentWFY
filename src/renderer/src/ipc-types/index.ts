export type { FilesApi } from './files.js'
export type { SqlApi } from './sql.js'
export type { TabsApi, TabViewBounds, MountTabViewRequest, UpdateTabViewBoundsRequest, DestroyTabViewRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent, TabData, TabDataType, TabState } from './tabs.js'
export type { SessionsApi } from './sessions.js'
export type { StoreApi } from './store.js'
export type { DialogApi } from './dialog.js'
export type { BusApi } from './bus.js'
export type { DbApi, AgentDbChange } from './db.js'
export type { TasksApi } from './tasks.js'

import type { FilesApi } from './files.js'
import type { SqlApi } from './sql.js'
import type { TabsApi } from './tabs.js'
import type { SessionsApi } from './sessions.js'
import type { StoreApi } from './store.js'
import type { DialogApi } from './dialog.js'
import type { BusApi } from './bus.js'
import type { DbApi } from './db.js'
import type { TasksApi } from './tasks.js'

export interface CommandPaletteApi {
  show(options?: { screen?: string; params?: Record<string, unknown> }): Promise<void>
  showFiltered(query: string): Promise<void>
}

export interface PluginsApi {
  call(method: string, params: unknown): Promise<unknown>
  methods(): Promise<string[]>
  install(packagePath: string): Promise<{ installed: string[] }>
  uninstall(pluginName: string): Promise<void>
}

export interface ProvidersApi {
  list(): Promise<Array<{ id: string; name: string; settingsView?: string }>>
  getStatusLine(providerId: string): Promise<string>
}

export interface AgentApi {
  createSession(opts?: { label?: string; prompt?: string; providerId?: string }): Promise<string>
  sendMessage(text: string, options?: { streamingBehavior?: 'followUp' }): Promise<void>
  abort(): Promise<void>
  closeSession(): Promise<void>
  loadSession(file: string): Promise<void>
  switchTo(sessionId: string): Promise<void>
  getSessionList(): Promise<unknown[]>
  setNotifyOnFinish(value: boolean): Promise<void>
  reconnect(): Promise<void>
  getSnapshot(): Promise<unknown>
  onSnapshot(callback: (snapshot: unknown) => void): () => void
  onStreaming(callback: (data: unknown) => void): () => void
  disposeSession(file: string): Promise<void>
}

export interface InstalledAgent {
  path: string
  name: string
  active: boolean
  initialized: boolean
}

export interface AgentSidebarApi {
  getInstalled(): Promise<InstalledAgent[]>
  switch(agentRoot: string): Promise<void>
  add(): Promise<string | null>
  addFromFile(): Promise<string | null>
  remove(agentRoot: string): Promise<void>
  showContextMenu(agentRoot: string): Promise<void>
  reorder(agentPaths: string[]): Promise<void>
  onSwitched(callback: (data: { agentRoot: string; agents: InstalledAgent[] }) => void): () => void
}

export interface AppIpc {
  files: FilesApi
  sql: SqlApi
  tabs: TabsApi
  sessions: SessionsApi
  store: StoreApi
  dialog: DialogApi
  bus: BusApi
  db: DbApi
  tasks: TasksApi
  plugins: PluginsApi
  providers: ProvidersApi
  commandPalette: CommandPaletteApi
  agent: AgentApi
  agentSidebar: AgentSidebarApi
  getAgentRoot(): Promise<string | null>
  getHttpApiPort(): Promise<number | null>
  getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null>
  getDefaultView(): Promise<{ viewId: number; title: string; viewUpdatedAt: number } | null>
}

declare global {
  interface Window {
    ipc?: AppIpc
  }
}
