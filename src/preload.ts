// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

interface RunSqlRequest {
  target?: 'agent' | 'sqlite-file';
  path?: string;
  sql: string;
  params?: any[];
  description?: string;
  confirmed?: boolean;
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
  viewId: string | number;
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

interface ExternalViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExternalViewMountRequest {
  tabId: string;
  viewId: string;
  src: string;
  bounds: ExternalViewBounds;
  visible: boolean;
}

interface ExternalViewBoundsRequest {
  tabId: string;
  bounds: ExternalViewBounds;
  visible: boolean;
}

interface ExternalViewDestroyRequest {
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

interface ExternalViewEventDetail {
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

const RUN_SQL_CHANNEL = 'electronAgentTools:runSql';
const LIST_SESSIONS_CHANNEL = 'electronAgentTools:listSessions';
const READ_SESSION_CHANNEL = 'electronAgentTools:readSession';
const WRITE_SESSION_CHANNEL = 'electronAgentTools:writeSession';
const READ_AUTH_CONFIG_CHANNEL = 'electronAgentTools:readAuthConfig';
const WRITE_AUTH_CONFIG_CHANNEL = 'electronAgentTools:writeAuthConfig';
const READ_LEGACY_API_KEY_CHANNEL = 'electronAgentTools:readLegacyApiKey';
const GET_TABS_CHANNEL = 'electronAgentTools:getTabs';
const OPEN_TAB_CHANNEL = 'electronAgentTools:openTab';
const CLOSE_TAB_CHANNEL = 'electronAgentTools:closeTab';
const SELECT_TAB_CHANNEL = 'electronAgentTools:selectTab';
const RELOAD_TAB_CHANNEL = 'electronAgentTools:reloadTab';
const CAPTURE_TAB_CHANNEL = 'electronAgentTools:captureTab';
const GET_TAB_CONSOLE_LOGS_CHANNEL = 'electronAgentTools:getTabConsoleLogs';
const EXEC_TAB_JS_CHANNEL = 'electronAgentTools:execTabJs';
const EXTERNAL_VIEW_MOUNT_CHANNEL = 'electronExternalView:mount';
const EXTERNAL_VIEW_BOUNDS_CHANNEL = 'electronExternalView:setBounds';
const EXTERNAL_VIEW_DESTROY_CHANNEL = 'electronExternalView:destroy';
const TAB_CONTEXT_MENU_CHANNEL = 'agentwfy:tabs:context-menu';
const EXTERNAL_VIEW_EVENT_CHANNEL = 'agentwfy:external-view-event';
const AGENT_DB_CHANGED_CHANNEL = 'agentwfy:agent-db-changed';
const DIALOG_OPEN_CHANNEL = 'dialog:open';
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

contextBridge.exposeInMainWorld('electronAgentTools', {
  read(path: string, offset?: number, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:read', path, offset, limit);
  },
  write(path: string, content: string): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:write', path, content);
  },
  edit(path: string, oldText: string, newText: string): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:edit', path, oldText, newText);
  },
  ls(path?: string, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:ls', path, limit);
  },
  mkdir(path: string, recursive?: boolean): Promise<void> {
    return ipcRenderer.invoke('electronAgentTools:mkdir', path, recursive);
  },
  remove(path: string, recursive?: boolean): Promise<void> {
    return ipcRenderer.invoke('electronAgentTools:remove', path, recursive);
  },
  find(pattern: string, path?: string, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:find', pattern, path, limit);
  },
  grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:grep', pattern, path, options);
  },
  runSql(request: {
    target?: 'agent' | 'sqlite-file';
    path?: string;
    sql: string;
    params?: any[];
    description?: string;
    confirmed?: boolean;
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
});

if (window.location.protocol !== 'agentview:') {
  contextBridge.exposeInMainWorld('electronClientTools', {
    openDialog(options: any): Promise<string[]> {
      return ipcRenderer.invoke(DIALOG_OPEN_CHANNEL, options);
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
    mountExternalView(request: ExternalViewMountRequest): Promise<void> {
      return ipcRenderer.invoke(EXTERNAL_VIEW_MOUNT_CHANNEL, request);
    },
    updateExternalViewBounds(request: ExternalViewBoundsRequest): Promise<void> {
      return ipcRenderer.invoke(EXTERNAL_VIEW_BOUNDS_CHANNEL, request);
    },
    destroyExternalView(request: ExternalViewDestroyRequest): Promise<void> {
      return ipcRenderer.invoke(EXTERNAL_VIEW_DESTROY_CHANNEL, request);
    },
    showTabContextMenu(request: TabContextMenuRequest): Promise<TabContextMenuAction> {
      return ipcRenderer.invoke(TAB_CONTEXT_MENU_CHANNEL, request);
    },
    onExternalViewEvent(callback: (detail: ExternalViewEventDetail) => void): () => void {
      const handler = (_event: unknown, detail: ExternalViewEventDetail) => callback(detail);
      ipcRenderer.on(EXTERNAL_VIEW_EVENT_CHANNEL, handler);
      return () => ipcRenderer.removeListener(EXTERNAL_VIEW_EVENT_CHANNEL, handler);
    },
    onAgentDbChanged(callback: (detail: AgentDbChangedEventDetail) => void): () => void {
      const handler = (_event: unknown, detail: AgentDbChangedEventDetail) => callback(detail);
      ipcRenderer.on(AGENT_DB_CHANGED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(AGENT_DB_CHANGED_CHANNEL, handler);
    },
  });
}
