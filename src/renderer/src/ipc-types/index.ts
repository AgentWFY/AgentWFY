export type { FilesApi } from './files.js'
export type { SqlApi } from './sql.js'
export type { TabsApi, TabViewBounds, MountTabViewRequest, UpdateTabViewBoundsRequest, DestroyTabViewRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent } from './tabs.js'
export type { SessionsApi } from './sessions.js'
export type { StoreApi } from './store.js'
export type { DialogApi } from './dialog.js'
export type { BusApi, AgentDbChange } from './bus.js'
export type { TasksApi } from './tasks.js'

import type { FilesApi } from './files.js'
import type { SqlApi } from './sql.js'
import type { TabsApi } from './tabs.js'
import type { SessionsApi } from './sessions.js'
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
  createSession(providerId: string, config: { sessionId: string; systemPrompt: string }): Promise<string>
  restoreSession(providerId: string, messages: unknown[], config: { sessionId: string; systemPrompt: string }): Promise<string>
  send(handle: string, input: unknown): Promise<void>
  getDisplayMessages(handle: string): Promise<unknown[]>
  onEvent(callback: (handle: string, output: unknown) => void): () => void
}

export interface AppIpc {
  files: FilesApi
  sql: SqlApi
  tabs: TabsApi
  sessions: SessionsApi
  store: StoreApi
  dialog: DialogApi
  bus: BusApi
  tasks: TasksApi
  net: NetApi
  plugins: PluginsApi
  providers: ProvidersApi
  commandPalette: CommandPaletteApi
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
