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

interface CaptureViewRequest {
  viewId: string | number;
}

interface GetViewConsoleLogsRequest {
  viewId: string | number;
  since?: number;
  limit?: number;
}

interface ExecViewJsRequest {
  viewId: string | number;
  code: string;
  timeoutMs?: number;
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

interface ExternalViewEventDetail {
  tabId: string;
  type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load';
  errorCode?: number;
  errorDescription?: string;
 }

interface RunSqlResponseDetail {
  requestId: string;
  target?: 'agent' | 'sqlite-file';
  path?: string;
  sql: string;
  params?: any[];
  description?: string;
  result?: any;
  error?: string;
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
const CAPTURE_VIEW_CHANNEL = 'electronAgentTools:captureView';
const GET_VIEW_CONSOLE_LOGS_CHANNEL = 'electronAgentTools:getViewConsoleLogs';
const EXEC_VIEW_JS_CHANNEL = 'electronAgentTools:execViewJs';
const EXTERNAL_VIEW_MOUNT_CHANNEL = 'electronExternalView:mount';
const EXTERNAL_VIEW_BOUNDS_CHANNEL = 'electronExternalView:setBounds';
const EXTERNAL_VIEW_DESTROY_CHANNEL = 'electronExternalView:destroy';
const EXTERNAL_VIEW_RELOAD_CHANNEL = 'electronExternalView:reload';
const EXTERNAL_VIEW_EVENT_CHANNEL = 'tradinglog:external-view-event';
const RUN_SQL_EVENT = 'tradinglog:run-sql';
const RUN_SQL_RESPONSE_EVENT = 'tradinglog:run-sql-response';
const AGENT_DB_CHANGED_CHANNEL = 'tradinglog:agent-db-changed';

let runSqlShimInstalled = false;

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

function toMediaUrl(relativePath: string): string {
  const input = typeof relativePath === 'string' ? relativePath : '';
  const normalized = input.replace(/^\/+/, '');
  const segments = normalized
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));

  if (segments.length === 0) {
    return 'media://';
  }

  if (segments.length === 1) {
    return `media://${segments[0]}`;
  }

  return `media://${segments[0]}/${segments.slice(1).join('/')}`;
}

function installRunSqlEventShim() {
  if (runSqlShimInstalled) {
    return;
  }

  runSqlShimInstalled = true;
  window.addEventListener(RUN_SQL_EVENT, async (event: Event) => {
    const customEvent = event as CustomEvent<any>;
    const detail = customEvent.detail || {};
    const requestId = typeof detail.requestId === 'string' ? detail.requestId : '';

    const response: RunSqlResponseDetail = {
      requestId,
      target: detail.target,
      path: detail.path,
      sql: typeof detail.sql === 'string' ? detail.sql : '',
      params: Array.isArray(detail.params) ? detail.params : undefined,
      description: typeof detail.description === 'string' ? detail.description : undefined,
    };

    try {
      const result = await invokeRunSql({
        target: detail.target,
        path: detail.path,
        sql: detail.sql,
        params: detail.params,
        description: detail.description,
        confirmed: detail.confirmed,
      });

      response.result = result;
    } catch (error: any) {
      response.error = error instanceof Error ? error.message : String(error);
    }

    window.dispatchEvent(new CustomEvent<RunSqlResponseDetail>(RUN_SQL_RESPONSE_EVENT, {
      detail: response,
    }));
  });
}

contextBridge.exposeInMainWorld('electronDialog', {
  open(options: any): Promise<string[]> {
    return ipcRenderer.invoke('dialog:open', options);
  },
});

contextBridge.exposeInMainWorld('electronStore', {
  getItem(key: string): Promise<any> {
    return ipcRenderer.invoke('electron-store:get', key);
  },
  setItem(key: string, value: any): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke('electron-store:set', key, value);
    }, 0);
    return Promise.resolve();
  },
  removeItem(key: string): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke('electron-store:remove', key);
    }, 0);
    return Promise.resolve();
  },
});

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
  captureView(request: CaptureViewRequest): Promise<{ base64: string; mimeType: 'image/png' }> {
    return ipcRenderer.invoke(CAPTURE_VIEW_CHANNEL, request);
  },
  getViewConsoleLogs(request: GetViewConsoleLogsRequest): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    return ipcRenderer.invoke(GET_VIEW_CONSOLE_LOGS_CHANNEL, request);
  },
  execViewJs(request: ExecViewJsRequest): Promise<any> {
    return ipcRenderer.invoke(EXEC_VIEW_JS_CHANNEL, request);
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
  reloadExternalView(request: { tabId: string }): Promise<void> {
    return ipcRenderer.invoke(EXTERNAL_VIEW_RELOAD_CHANNEL, request);
  },
  onExternalViewEvent(callback: (detail: ExternalViewEventDetail) => void): () => void {
    const handler = (_event: unknown, detail: ExternalViewEventDetail) => callback(detail);
    ipcRenderer.on(EXTERNAL_VIEW_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EXTERNAL_VIEW_EVENT_CHANNEL, handler);
  },
  captureWindowPng(): Promise<{ path: string; base64: string }> {
    return ipcRenderer.invoke('electronAgentTools:captureWindowPng');
  },
  getConsoleLogs(since?: number): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    return ipcRenderer.invoke('electronAgentTools:getConsoleLogs', since);
  },
  onAgentDbChanged(callback: (detail: AgentDbChangedEventDetail) => void): () => void {
    const handler = (_event: unknown, detail: AgentDbChangedEventDetail) => callback(detail);
    ipcRenderer.on(AGENT_DB_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AGENT_DB_CHANGED_CHANNEL, handler);
  },
});

contextBridge.exposeInMainWorld('tradinglogViewBridge', {
  runSql(request: RunSqlRequest): Promise<any> {
    return invokeRunSql(request);
  },
  mediaUrl(relativePath: string): string {
    return toMediaUrl(relativePath);
  },
  installRunSqlEventShim(): void {
    installRunSqlEventShim();
  },
});

if (window.location.protocol === 'agentview:') {
  installRunSqlEventShim();
}
