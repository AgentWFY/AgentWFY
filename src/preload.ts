import { contextBridge, ipcRenderer } from 'electron';
import { Channels } from './ipc/channels';

// --- Helpers ---

interface RunSqlRequest {
  target?: 'agent' | 'sqlite-file';
  path?: string;
  sql: string;
  params?: unknown[];
  description?: string;
}

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

function invokeRunSql(request: RunSqlRequest): Promise<unknown[]> {
  const normalized = normalizeRunSqlRequest(request);
  return ipcRenderer.invoke(Channels.sql.run, normalized);
}

// --- Builder functions for shared domains ---

function buildFilesApi() {
  return {
    read(path: string, offset?: number, limit?: number): Promise<string> {
      return ipcRenderer.invoke(Channels.files.read, path, offset, limit);
    },
    write(path: string, content: string): Promise<string> {
      return ipcRenderer.invoke(Channels.files.write, path, content);
    },
    edit(path: string, oldText: string, newText: string): Promise<string> {
      return ipcRenderer.invoke(Channels.files.edit, path, oldText, newText);
    },
    ls(path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke(Channels.files.ls, path, limit);
    },
    mkdir(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke(Channels.files.mkdir, path, recursive);
    },
    remove(path: string, recursive?: boolean): Promise<void> {
      return ipcRenderer.invoke(Channels.files.remove, path, recursive);
    },
    find(pattern: string, path?: string, limit?: number): Promise<string> {
      return ipcRenderer.invoke(Channels.files.find, pattern, path, limit);
    },
    grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string> {
      return ipcRenderer.invoke(Channels.files.grep, pattern, path, options);
    },
  };
}

function buildSqlApi() {
  return {
    run(request: RunSqlRequest): Promise<unknown[]> {
      return invokeRunSql(request);
    },
  };
}

function buildAgentTabsApi() {
  return {
    getTabs(): Promise<unknown> {
      return ipcRenderer.invoke(Channels.tabs.getTabs);
    },
    openTab(request: unknown): Promise<void> {
      return ipcRenderer.invoke(Channels.tabs.openTab, request);
    },
    closeTab(request: unknown): Promise<void> {
      return ipcRenderer.invoke(Channels.tabs.closeTab, request);
    },
    selectTab(request: unknown): Promise<void> {
      return ipcRenderer.invoke(Channels.tabs.selectTab, request);
    },
    reloadTab(request: unknown): Promise<void> {
      return ipcRenderer.invoke(Channels.tabs.reloadTab, request);
    },
    captureTab(request: unknown): Promise<{ base64: string; mimeType: 'image/png' }> {
      return ipcRenderer.invoke(Channels.tabs.captureTab, request);
    },
    getConsoleLogs(request: unknown): Promise<Array<{ level: string; message: string; timestamp: number }>> {
      return ipcRenderer.invoke(Channels.tabs.getConsoleLogs, request);
    },
    execJs(request: unknown): Promise<unknown> {
      return ipcRenderer.invoke(Channels.tabs.execJs, request);
    },
  };
}

function buildBusAgentApi() {
  return {
    publish(topic: string, data: unknown): Promise<void> {
      return ipcRenderer.invoke(Channels.bus.publish, topic, data);
    },
    waitFor(topic: string, timeoutMs?: number): Promise<unknown> {
      return ipcRenderer.invoke(Channels.bus.waitFor, topic, timeoutMs);
    },
  };
}

// --- Protocol detection ---

const isAgentView = window.location.protocol === 'agentview:';
const isApp = window.location.protocol === 'app:';

// --- app:// — expose window.ipc (domain-namespaced, all domains) ---

if (isApp) {
  const files = buildFilesApi();
  const sql = buildSqlApi();
  const agentTabs = buildAgentTabsApi();
  const busAgent = buildBusAgentApi();

  contextBridge.exposeInMainWorld('ipc', {
    files,
    sql,
    tabs: {
      ...agentTabs,
      mountView(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.mountView, request);
      },
      updateViewBounds(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.updateViewBounds, request);
      },
      destroyView(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.destroyView, request);
      },
      showContextMenu(request: unknown): Promise<unknown> {
        return ipcRenderer.invoke(Channels.tabs.showContextMenu, request);
      },
      onViewEvent(callback: (detail: unknown) => void): () => void {
        const handler = (_event: unknown, detail: unknown) => callback(detail);
        ipcRenderer.on(Channels.tabs.viewEvent, handler);
        return () => ipcRenderer.removeListener(Channels.tabs.viewEvent, handler);
      },
    },
    sessions: {
      list(limit?: number): Promise<Array<{ name: string; updatedAt: number }>> {
        return ipcRenderer.invoke(Channels.sessions.list, limit);
      },
      read(sessionFileName: string): Promise<string> {
        return ipcRenderer.invoke(Channels.sessions.read, sessionFileName);
      },
      write(sessionFileName: string, content: string): Promise<void> {
        return ipcRenderer.invoke(Channels.sessions.write, sessionFileName, content);
      },
    },
    auth: {
      readConfig(): Promise<string> {
        return ipcRenderer.invoke(Channels.auth.readConfig);
      },
      writeConfig(content: string): Promise<void> {
        return ipcRenderer.invoke(Channels.auth.writeConfig, content);
      },
      readLegacyKey(): Promise<string> {
        return ipcRenderer.invoke(Channels.auth.readLegacyKey);
      },
    },
    store: {
      get(key: string): Promise<unknown> {
        return ipcRenderer.invoke(Channels.store.get, key);
      },
      set(key: string, value: unknown): Promise<void> {
        setTimeout(() => {
          ipcRenderer.invoke(Channels.store.set, key, value);
        }, 0);
        return Promise.resolve();
      },
      remove(key: string): Promise<void> {
        setTimeout(() => {
          ipcRenderer.invoke(Channels.store.remove, key);
        }, 0);
        return Promise.resolve();
      },
    },
    dialog: {
      open(options: unknown): Promise<string[]> {
        return ipcRenderer.invoke(Channels.dialog.open, options);
      },
      openExternal(url: string): Promise<void> {
        return ipcRenderer.invoke(Channels.dialog.openExternal, url);
      },
    },
    bus: {
      ...busAgent,
      onForwardPublish(callback: (detail: { topic: string; data: unknown }) => void): () => void {
        const handler = (_event: unknown, detail: { topic: string; data: unknown }) => callback(detail);
        ipcRenderer.on(Channels.bus.forwardPublish, handler);
        return () => ipcRenderer.removeListener(Channels.bus.forwardPublish, handler);
      },
      onForwardWaitFor(callback: (detail: { waiterId: string; topic: string; timeoutMs?: number }) => void): () => void {
        const handler = (_event: unknown, detail: { waiterId: string; topic: string; timeoutMs?: number }) => callback(detail);
        ipcRenderer.on(Channels.bus.forwardWaitFor, handler);
        return () => ipcRenderer.removeListener(Channels.bus.forwardWaitFor, handler);
      },
      waitForResolved(waiterId: string, data: unknown): void {
        ipcRenderer.send(Channels.bus.waitForResolved, { waiterId, data });
      },
      onDbChanged(callback: (detail: { table: string; rowId: number; op: 'insert' | 'update' | 'delete' }) => void): () => void {
        const handler = (_event: unknown, detail: { table: string; rowId: number; op: 'insert' | 'update' | 'delete' }) => callback(detail);
        ipcRenderer.on(Channels.bus.dbChanged, handler);
        return () => ipcRenderer.removeListener(Channels.bus.dbChanged, handler);
      },
      onForwardSpawnAgent(callback: (detail: { waiterId: string; prompt: string }) => void): () => void {
        const handler = (_event: unknown, detail: { waiterId: string; prompt: string }) => callback(detail);
        ipcRenderer.on(Channels.bus.forwardSpawnAgent, handler);
        return () => ipcRenderer.removeListener(Channels.bus.forwardSpawnAgent, handler);
      },
      spawnAgentResult(waiterId: string, result: unknown): void {
        ipcRenderer.send(Channels.bus.spawnAgentResult, { waiterId, result });
      },
      spawnAgent(prompt: string): Promise<{ agentId: string }> {
        return ipcRenderer.invoke(Channels.bus.spawnAgent, prompt);
      },
    },
    tasks: {
      start(taskId: number): Promise<string> {
        return ipcRenderer.invoke(Channels.tasks.start, taskId);
      },
      stop(runId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tasks.stop, runId);
      },
      run(taskId: number): Promise<string> {
        return ipcRenderer.invoke(Channels.tasks.run, taskId);
      },
      getRuns(): Promise<unknown[]> {
        return ipcRenderer.invoke(Channels.tasks.getRuns);
      },
      listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string }>> {
        return ipcRenderer.invoke(Channels.tasks.listLogHistory);
      },
      onStateChanged(callback: (runs: unknown[]) => void): () => void {
        const handler = (_event: unknown, runs: unknown[]) => callback(runs);
        ipcRenderer.on(Channels.tasks.stateChanged, handler);
        return () => ipcRenderer.removeListener(Channels.tasks.stateChanged, handler);
      },
      listLogs(limit?: number): Promise<Array<{ name: string; updatedAt: number }>> {
        return ipcRenderer.invoke(Channels.tasks.listLogs, limit);
      },
      readLog(logFileName: string): Promise<string> {
        return ipcRenderer.invoke(Channels.tasks.readLog, logFileName);
      },
      writeLog(logFileName: string, content: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tasks.writeLog, logFileName, content);
      },
    },
  });
}

// --- agentview:// — expose window.agentwfy (flat API, agent tools subset only) ---

if (isAgentView) {
  const files = buildFilesApi();
  const agentTabs = buildAgentTabsApi();
  const busAgent = buildBusAgentApi();

  contextBridge.exposeInMainWorld('agentwfy', {
    ...files,
    runSql(request: RunSqlRequest): Promise<unknown[]> {
      return invokeRunSql(request);
    },
    ...agentTabs,
    // Flat aliases matching WorkerHostMethodMap keys
    getTabConsoleLogs: agentTabs.getConsoleLogs,
    execTabJs: agentTabs.execJs,
    ...busAgent,
    spawnAgent(prompt: string): Promise<{ agentId: string }> {
      return ipcRenderer.invoke(Channels.bus.spawnAgent, prompt);
    },
    startTask(taskId: number): Promise<{ runId: string }> {
      return ipcRenderer.invoke(Channels.tasks.start, taskId);
    },
    stopTask(runId: string): Promise<void> {
      return ipcRenderer.invoke(Channels.tasks.stop, runId);
    },
  });
}
