export type { SqlApi } from './sql.js'
export type { TabsApi, TabViewBounds, UpdateTabViewBoundsRequest, TabContextMenuAction, TabContextMenuRequest, TabViewEvent, TabData, TabDataType, TabState } from './tabs.js'
export type { SessionsApi } from './sessions.js'
export type { StoreApi } from './store.js'
export type { DialogApi } from './dialog.js'
export type { DbApi, AgentDbChange } from './db.js'
export type { TasksApi } from './tasks.js'
export type { TracesApi, TraceEvent, TraceExecEvent, TraceCallEvent } from './traces.js'

import type { SqlApi } from './sql.js'
import type { TabsApi } from './tabs.js'
import type { SessionsApi } from './sessions.js'
import type { StoreApi } from './store.js'
import type { DialogApi } from './dialog.js'
import type { DbApi } from './db.js'
import type { TasksApi } from './tasks.js'
import type { TracesApi } from './traces.js'
import type { FileContent } from '../../agent/types.js'
import type { ProviderState } from '../../ipc/providers.js'
import type { AgentSnapshot, AgentStreamingUpdate, InstalledAgent, SettingChangedPayload, SidebarSwitchedPayload, TaskRunFinishedPayload, TaskRunStartedPayload } from '../../ipc/schema.js'

export type { ProviderState, AgentSnapshot, AgentStreamingUpdate, InstalledAgent, SettingChangedPayload, SidebarSwitchedPayload, TaskRunFinishedPayload, TaskRunStartedPayload }

export interface CommandPaletteApi {
  show(options?: { screen?: string; params?: Record<string, unknown> }): Promise<void>
  showFiltered(query: string): Promise<void>
}

export interface ProvidersApi {
  list(): Promise<Array<{ id: string; name: string; settingsView?: string }>>
  getStatusLine(providerId: string): Promise<string>
  setDefault(providerId: string): Promise<void>
  onStateChanged(callback: (state: ProviderState) => void): () => void
}

export interface AgentApi {
  createSession(opts?: { label?: string; prompt?: string; providerId?: string; files?: FileContent[] }): Promise<string>
  sendMessage(text: string, options?: { streamingBehavior?: 'followUp'; files?: FileContent[] }): Promise<void>
  abort(): Promise<void>
  closeSession(): Promise<void>
  loadSession(file: string): Promise<void>
  switchTo(sessionId: string): Promise<void>
  getSessionList(): Promise<unknown[]>
  setNotifyOnFinish(value: boolean): Promise<void>
  reconnect(): Promise<void>
  getSnapshot(): Promise<AgentSnapshot>
  onSnapshot(callback: (snapshot: AgentSnapshot) => void): () => void
  onStreaming(callback: (data: AgentStreamingUpdate) => void): () => void
  disposeSession(file: string): Promise<void>
  retryNow(): Promise<void>
}

export interface ZenModeApi {
  toggle(): Promise<void>
  set(value: boolean): Promise<void>
  onChanged(callback: (isZen: boolean) => void): () => void
}

export interface PreviewCursorApi {
  setPos(x: number, y: number): Promise<void>
  setVisible(visible: boolean): Promise<void>
  flash(): Promise<void>
}

export interface AgentSidebarApi {
  getInstalled(): Promise<InstalledAgent[]>
  switch(agentRoot: string): Promise<void>
  add(): Promise<string | null>
  addFromFile(): Promise<string | null>
  remove(agentRoot: string): Promise<void>
  showContextMenu(agentRoot: string): Promise<void>
  reorder(fromIndex: number, toIndex: number): Promise<void>
  onSwitched(callback: (data: SidebarSwitchedPayload) => void): () => void
}

export interface AppIpc {
  sql: SqlApi
  agentRoot: string | null
  tabs: TabsApi
  sessions: SessionsApi
  store: StoreApi
  dialog: DialogApi
  db: DbApi
  tasks: TasksApi
  providers: ProvidersApi
  commandPalette: CommandPaletteApi
  agent: AgentApi
  traces: TracesApi
  zenMode: ZenModeApi
  previewCursor: PreviewCursorApi
  agentSidebar: AgentSidebarApi
  restart(): Promise<void>
  stop(): Promise<void>
  reloadRenderer(): Promise<void>
  getAgentRoot(): Promise<string | null>
  openAgentRoot(): Promise<void>
  getAgentDisplayPath(): Promise<string | null>
  getHttpApiPort(): Promise<number | null>
  getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null>
  getDefaultView(): Promise<{ viewName: string; title: string; viewUpdatedAt: number } | null>
  getSetting(key: string, fallback?: unknown): Promise<unknown>
  onSettingChanged(callback: (data: SettingChangedPayload) => void): () => void
}

declare global {
  interface Window {
    ipc?: AppIpc
  }
}
