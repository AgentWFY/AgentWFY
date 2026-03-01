// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

interface RunSqlRequest {
  target?: 'agent' | 'sqlite-file';
  path?: string;
  sql: string;
  params?: any[];
  description?: string;
}

interface CaptureTabRequest {
  tabId: string;
}

interface GetTabConsoleLogsRequest {
  tabId: string;
  since?: number;
  limit?: number;
}

interface ExecTabJsRequest {
  tabId: string;
  code: string;
  timeoutMs?: number;
}

interface OpenTabRequest {
  viewId?: string | number;
  filePath?: string;
  url?: string;
  title?: string;
}

interface CloseTabRequest {
  tabId: string;
}

interface SelectTabRequest {
  tabId: string;
}

interface ReloadTabRequest {
  tabId: string;
}

interface TabViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TabViewMountRequest {
  tabId: string;
  viewId: string;
  src: string;
  bounds: TabViewBounds;
  visible: boolean;
}

interface TabViewBoundsRequest {
  tabId: string;
  bounds: TabViewBounds;
  visible: boolean;
}

interface TabViewDestroyRequest {
  tabId: string;
}

type TabContextMenuAction = 'toggle-pin' | 'reload' | null;

interface TabContextMenuRequest {
  x: number;
  y: number;
  pinned: boolean;
  viewChanged?: boolean;
  tabId?: string;
}

interface TabViewEventDetail {
  tabId: string;
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load';
  errorCode?: number;
  errorDescription?: string;
 }

interface AgentDbChangeDetail {
  seq: number;
  table: string;
  rowId: number;
  op: 'insert' | 'update' | 'delete';
  changedAt: number;
}

interface AgentDbChangedEventDetail {
  cursor: number;
  changes: AgentDbChangeDetail[];
}

const RUN_SQL_CHANNEL = 'agentwfy:runSql';
const LIST_SESSIONS_CHANNEL = 'app:listSessions';
const READ_SESSION_CHANNEL = 'app:readSession';
const WRITE_SESSION_CHANNEL = 'app:writeSession';
const READ_AUTH_CONFIG_CHANNEL = 'app:readAuthConfig';
const WRITE_AUTH_CONFIG_CHANNEL = 'app:writeAuthConfig';
const READ_LEGACY_API_KEY_CHANNEL = 'app:readLegacyApiKey';
const GET_TABS_CHANNEL = 'agentwfy:getTabs';
const OPEN_TAB_CHANNEL = 'agentwfy:openTab';
const CLOSE_TAB_CHANNEL = 'agentwfy:closeTab';
const SELECT_TAB_CHANNEL = 'agentwfy:selectTab';
const RELOAD_TAB_CHANNEL = 'agentwfy:reloadTab';
const CAPTURE_TAB_CHANNEL = 'agentwfy:captureTab';
const GET_TAB_CONSOLE_LOGS_CHANNEL = 'agentwfy:getTabConsoleLogs';
const EXEC_TAB_JS_CHANNEL = 'agentwfy:execTabJs';
const TAB_VIEW_MOUNT_CHANNEL = 'tabView:mount';
const TAB_VIEW_BOUNDS_CHANNEL = 'tabView:setBounds';
const TAB_VIEW_DESTROY_CHANNEL = 'tabView:destroy';
const TAB_CONTEXT_MENU_CHANNEL = 'app:tabs:context-menu';
const TAB_VIEW_EVENT_CHANNEL = 'app:tab-view-event';
const AGENT_DB_CHANGED_CHANNEL = 'app:agent-db-changed';
const DIALOG_OPEN_CHANNEL = 'dialog:open';
const OPEN_URL_IN_DEFAULT_BROWSER_CHANNEL = 'shell:openUrlInDefaultBrowser';
const STORE_GET_CHANNEL = 'electron-store:get';
const STORE_SET_CHANNEL = 'electron-store:set';
const STORE_REMOVE_CHANNEL = 'electron-store:remove';

function normalizeRunSqlRequest(request: RunSqlRequest): Required<Pick<RunSqlRequest, 'target' | 'sql'>> & RunSqlRequest {
  if (!request || typeof request !== 'object') {
    throw new Error('runSql request payload is required');
  }

  if (typeof request.sql !== 'string' || request.sql.trim().length === 0) {
    throw new Error('runSql request requires a non-empty sql string');
  }

  const target = request.target ?? 'agent';
  if (target !== 'agent' && target !== 'sqlite-file') {
    throw new Error('runSql target must be "agent" or "sqlite-file"');
  }

  return {
    ...request,
    target,
    sql: request.sql,
  };
}

function invokeRunSql(request: RunSqlRequest): Promise<any> {
  const normalized = normalizeRunSqlRequest(request);
  return ipcRenderer.invoke(RUN_SQL_CHANNEL, normalized);
}

const isAgentView = window.location.protocol === 'agentview:';
const isApp = window.location.protocol === 'app:';

if (isApp) {
  contextBridge.exposeInMainWorld('agentwfy', {
    read(path: string, offset?: number, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:read', path, offset, limit);
    },
    write(path: string, content: string): Promise<string> {
      return ipcRenderer.invoke('agentwfy:write', path, content);
    },
    edit(path: string, oldText: string, newText: string): Promise<string> {
      return ipcRenderer.invoke('agentwfy:edit', path, oldText, newText);
    },
    ls(path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:ls', path, limit);
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('agentwfy:mkdir', path, recursive);
    },
    remove(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('agentwfy:remove', path, recursive);
    },
    find(pattern: string, path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:find', pattern, path, limit);
    },
    grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string> {
      return ipcRenderer.invoke('agentwfy:grep', pattern, path, options);
    },
    runSql(request: {
      target?: 'agent' | 'sqlite-file';
      path?: string;
      sql: string;
      params?: any[];
      description?: string;
    }): Promise<any> {
      return invokeRunSql(request);
    },
    getTabs(): Promise<any> {
      return ipcRenderer.invoke(GET_TABS_CHANNEL);
    },
    openTab(request: OpenTabRequest): Promise<void> {
      return ipcRenderer.invoke(OPEN_TAB_CHANNEL, request);
    },
    closeTab(request: CloseTabRequest): Promise<void> {
      return ipcRenderer.invoke(CLOSE_TAB_CHANNEL, request);
    },
    selectTab(request: SelectTabRequest): Promise<void> {
      return ipcRenderer.invoke(SELECT_TAB_CHANNEL, request);
    },
    reloadTab(request: ReloadTabRequest): Promise<void> {
      return ipcRenderer.invoke(RELOAD_TAB_CHANNEL, request);
    },
    captureTab(request: CaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }> {
      return ipcRenderer.invoke(CAPTURE_TAB_CHANNEL, request);
    },
    getTabConsoleLogs(request: GetTabConsoleLogsRequest): Promise<Array<{ level: string; message: string; timestamp: number }>> {
      return ipcRenderer.invoke(GET_TAB_CONSOLE_LOGS_CHANNEL, request);
    },
    execTabJs(request: ExecTabJsRequest): Promise<any> {
      return ipcRenderer.invoke(EXEC_TAB_JS_CHANNEL, request);
    },
    busPublish(topic: string, data: unknown): Promise<void> {
      return ipcRenderer.invoke('bus:publish', topic, data);
    },
    busWaitFor(topic: string, timeoutMs?: number): Promise<unknown> {
      return ipcRenderer.invoke('bus:waitFor', topic, timeoutMs);
    },
    spawnAgent(prompt: string): Promise<{ agentId: string }> {
      return ipcRenderer.invoke('agentwfy:spawnAgent', prompt);
    },
  });
}

if (!isAgentView) {
  contextBridge.exposeInMainWorld('electronClientTools', {
    openDialog(options: any): Promise<string[]> {
      return ipcRenderer.invoke(DIALOG_OPEN_CHANNEL, options);
    },
    openUrlInDefaultBrowser(url: string): Promise<void> {
      return ipcRenderer.invoke(OPEN_URL_IN_DEFAULT_BROWSER_CHANNEL, url);
    },
    getStoreItem(key: string): Promise<any> {
      return ipcRenderer.invoke(STORE_GET_CHANNEL, key);
    },
    setStoreItem(key: string, value: any): Promise<void> {
      setTimeout(() => {
        ipcRenderer.invoke(STORE_SET_CHANNEL, key, value);
      }, 0);
      return Promise.resolve();
    },
    removeStoreItem(key: string): Promise<void> {
      setTimeout(() => {
        ipcRenderer.invoke(STORE_REMOVE_CHANNEL, key);
      }, 0);
      return Promise.resolve();
    },
    listSessions(limit?: number): Promise<Array<{ name: string; updatedAt: number }>> {
      return ipcRenderer.invoke(LIST_SESSIONS_CHANNEL, limit);
    },
    readSession(sessionFileName: string): Promise<string> {
      return ipcRenderer.invoke(READ_SESSION_CHANNEL, sessionFileName);
    },
    writeSession(sessionFileName: string, content: string): Promise<void> {
      return ipcRenderer.invoke(WRITE_SESSION_CHANNEL, sessionFileName, content);
    },
    readAuthConfig(): Promise<string> {
      return ipcRenderer.invoke(READ_AUTH_CONFIG_CHANNEL);
    },
    writeAuthConfig(content: string): Promise<void> {
      return ipcRenderer.invoke(WRITE_AUTH_CONFIG_CHANNEL, content);
    },
    readLegacyApiKey(): Promise<string> {
      return ipcRenderer.invoke(READ_LEGACY_API_KEY_CHANNEL);
    },
    mountTabView(request: TabViewMountRequest): Promise<void> {
      return ipcRenderer.invoke(TAB_VIEW_MOUNT_CHANNEL, request);
    },
    updateTabViewBounds(request: TabViewBoundsRequest): Promise<void> {
      return ipcRenderer.invoke(TAB_VIEW_BOUNDS_CHANNEL, request);
    },
    destroyTabView(request: TabViewDestroyRequest): Promise<void> {
      return ipcRenderer.invoke(TAB_VIEW_DESTROY_CHANNEL, request);
    },
    showTabContextMenu(request: TabContextMenuRequest): Promise<TabContextMenuAction> {
      return ipcRenderer.invoke(TAB_CONTEXT_MENU_CHANNEL, request);
    },
    onTabViewEvent(callback: (detail: TabViewEventDetail) => void): () => void {
      const handler = (_event: unknown, detail: TabViewEventDetail) => callback(detail);
      ipcRenderer.on(TAB_VIEW_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(TAB_VIEW_EVENT_CHANNEL, handler);
    },
    onAgentDbChanged(callback: (detail: AgentDbChangedEventDetail) => void): () => void {
      const handler = (_event: unknown, detail: AgentDbChangedEventDetail) => callback(detail);
      ipcRenderer.on(AGENT_DB_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AGENT_DB_CHANGED_CHANNEL, handler);
    },
    onBusForwardPublish(callback: (detail: { topic: string; data: unknown }) => void): () => void {
      const handler = (_event: unknown, detail: { topic: string; data: unknown }) => callback(detail);
      ipcRenderer.on('bus:forward-publish', handler);
      return () => ipcRenderer.removeListener('bus:forward-publish', handler);
    },
    onBusForwardWaitFor(callback: (detail: { waiterId: string; topic: string; timeoutMs?: number }) => void): () => void {
      const handler = (_event: unknown, detail: { waiterId: string; topic: string; timeoutMs?: number }) => callback(detail);
      ipcRenderer.on('bus:forward-waitFor', handler);
      return () => ipcRenderer.removeListener('bus:forward-waitFor', handler);
    },
    busWaitForResolved(waiterId: string, data: unknown): void {
      ipcRenderer.send('bus:waitFor-resolved', { waiterId, data });
    },
    onAgentForwardSpawnAgent(callback: (detail: { waiterId: string; prompt: string }) => void): () => void {
      const handler = (_event: unknown, detail: { waiterId: string; prompt: string }) => callback(detail);
      ipcRenderer.on('agent:forward-spawnAgent', handler);
      return () => ipcRenderer.removeListener('agent:forward-spawnAgent', handler);
    },
    agentSpawnAgentResult(waiterId: string, result: unknown): void {
      ipcRenderer.send('agent:spawnAgent-result', { waiterId, result });
    },
  });
}

if (isAgentView) {
  contextBridge.exposeInMainWorld('agentwfy', {
    read(path: string, offset?: number, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:read', path, offset, limit);
    },
    write(path: string, content: string): Promise<string> {
      return ipcRenderer.invoke('agentwfy:write', path, content);
    },
    edit(path: string, oldText: string, newText: string): Promise<string> {
      return ipcRenderer.invoke('agentwfy:edit', path, oldText, newText);
    },
    ls(path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:ls', path, limit);
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('agentwfy:mkdir', path, recursive);
    },
    remove(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke('agentwfy:remove', path, recursive);
    },
    find(pattern: string, path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke('agentwfy:find', pattern, path, limit);
    },
    grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string> {
      return ipcRenderer.invoke('agentwfy:grep', pattern, path, options);
    },
    runSql(request: {
      target?: 'agent' | 'sqlite-file';
      path?: string;
      sql: string;
      params?: any[];
      description?: string;
    }): Promise<any> {
      return invokeRunSql(request);
    },
    getTabs(): Promise<any> {
      return ipcRenderer.invoke(GET_TABS_CHANNEL);
    },
    openTab(request: OpenTabRequest): Promise<void> {
      return ipcRenderer.invoke(OPEN_TAB_CHANNEL, request);
    },
    closeTab(request: CloseTabRequest): Promise<void> {
      return ipcRenderer.invoke(CLOSE_TAB_CHANNEL, request);
    },
    selectTab(request: SelectTabRequest): Promise<void> {
      return ipcRenderer.invoke(SELECT_TAB_CHANNEL, request);
    },
    reloadTab(request: ReloadTabRequest): Promise<void> {
      return ipcRenderer.invoke(RELOAD_TAB_CHANNEL, request);
    },
    captureTab(request: CaptureTabRequest): Promise<{ base64: string; mimeType: 'image/png' }> {
      return ipcRenderer.invoke(CAPTURE_TAB_CHANNEL, request);
    },
    getTabConsoleLogs(request: GetTabConsoleLogsRequest): Promise<Array<{ level: string; message: string; timestamp: number }>> {
      return ipcRenderer.invoke(GET_TAB_CONSOLE_LOGS_CHANNEL, request);
    },
    execTabJs(request: ExecTabJsRequest): Promise<any> {
      return ipcRenderer.invoke(EXEC_TAB_JS_CHANNEL, request);
    },
    publish(topic: string, data: unknown): Promise<void> {
      return ipcRenderer.invoke('bus:publish', topic, data);
    },
    waitFor(topic: string, timeoutMs?: number): Promise<unknown> {
      return ipcRenderer.invoke('bus:waitFor', topic, timeoutMs);
    },
    spawnAgent(prompt: string): Promise<{ agentId: string }> {
      return ipcRenderer.invoke('agentwfy:spawnAgent', prompt);
    },
  });
}
