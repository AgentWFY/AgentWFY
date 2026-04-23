import { contextBridge, ipcRenderer } from 'electron';
import { Channels } from './ipc/channels.cjs';
import type { PushMap, PushChannel } from './ipc/schema.js';
import type { AppIpc, TraceEvent } from './renderer/ipc-types/index.js';

// --- Helpers ---

/** Typed listener for main→renderer push channels. */
function typedOn<C extends PushChannel>(channel: C, callback: (data: PushMap[C]) => void): () => void {
  const handler = (_event: unknown, data: PushMap[C]) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

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

// --- Builder functions ---

function buildSqlApi() {
  return {
    run(request: RunSqlRequest): Promise<unknown[]> {
      return invokeRunSql(request);
    },
  };
}

// --- Protocol detection ---

const isAgentView = window.location.protocol === 'agentview:';
const isApp = window.location.protocol === 'app:';

// --- app:// — expose window.ipc (domain-namespaced, all domains) ---

if (isApp) {
  const sql = buildSqlApi();

  let agentRootSync: string | null = null;
  try {
    agentRootSync = ipcRenderer.sendSync(Channels.app.getAgentRoot) ?? null;
  } catch {
    // Silently continue — sendSync may fail if context is not yet ready.
  }

  const api = {
    sql,
    agentRoot: agentRootSync,
    tabs: {
      openTab(request: unknown): Promise<{ tabId: string }> {
        return ipcRenderer.invoke(Channels.tabs.openTab, request);
      },
      closeTab(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.closeTab, request);
      },
      selectTab(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.selectTab, request);
      },
      updateViewBounds(request: unknown): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.updateViewBounds, request);
      },
      showContextMenu(request: unknown): Promise<'toggle-pin' | 'reload' | null> {
        return ipcRenderer.invoke(Channels.tabs.showContextMenu, request);
      },
      onViewEvent(callback: (detail: PushMap['tabs:viewEvent']) => void): () => void {
        return typedOn(Channels.tabs.viewEvent, callback);
      },
      onStateChanged(callback: (state: PushMap['tabs:stateChanged']) => void): () => void {
        return typedOn(Channels.tabs.stateChanged, callback);
      },
      getTabState(): Promise<PushMap['tabs:stateChanged']> {
        return ipcRenderer.invoke(Channels.tabs.getState);
      },
      reorderTabs(fromIndex: number, toIndex: number): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.reorderTabs, { fromIndex, toIndex });
      },
      togglePin(tabId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.togglePin, tabId);
      },
      revealTab(tabId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.revealTab, tabId);
      },
      toggleDevTools(tabId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tabs.toggleDevTools, tabId);
      },
      describe(): Promise<unknown> {
        return ipcRenderer.invoke(Channels.tabs.describe);
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
    store: {
      get<T = unknown>(key: string): Promise<T> {
        return ipcRenderer.invoke(Channels.store.get, key) as Promise<T>;
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
    db: {
      onDbChanged(callback: (detail: PushMap['db:changed']) => void): () => void {
        return typedOn(Channels.db.changed, callback);
      },
    },
    commandPalette: {
      show(options?: { screen?: string; params?: Record<string, unknown> }): Promise<void> {
        if (options?.screen) {
          return ipcRenderer.invoke('app:command-palette:opened-at-screen', options);
        }
        return ipcRenderer.invoke('app:command-palette:show-filtered', '');
      },
      showFiltered(query: string): Promise<void> {
        return ipcRenderer.invoke('app:command-palette:show-filtered', query);
      },
    },
    restart(): Promise<void> {
      return ipcRenderer.invoke(Channels.app.restart);
    },
    stop(): Promise<void> {
      return ipcRenderer.invoke(Channels.app.stop);
    },
    reloadRenderer(): Promise<void> {
      return ipcRenderer.invoke(Channels.app.reloadRenderer);
    },
    getAgentRoot(): Promise<string | null> {
      return ipcRenderer.invoke(Channels.app.getAgentRoot);
    },
    openAgentRoot(): Promise<void> {
      return ipcRenderer.invoke(Channels.app.openAgentRoot);
    },
    getAgentDisplayPath(): Promise<string | null> {
      return ipcRenderer.invoke(Channels.app.getAgentDisplayPath);
    },
    getHttpApiPort(): Promise<number | null> {
      return ipcRenderer.invoke(Channels.app.getHttpApiPort);
    },
    getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null> {
      return ipcRenderer.invoke(Channels.app.getBackupStatus);
    },
    getDefaultView(): Promise<{ viewName: string; title: string; viewUpdatedAt: number } | null> {
      return ipcRenderer.invoke(Channels.app.getDefaultView);
    },
    tasks: {
      start(taskName: string, input?: unknown, origin?: unknown): Promise<{ runId: string }> {
        return ipcRenderer.invoke(Channels.tasks.start, taskName, input, origin);
      },
      stop(runId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tasks.stop, runId);
      },
      listRunning(): Promise<Array<{ runId: string; taskName: string; title: string; status: string; origin: unknown; startedAt: number }>> {
        return ipcRenderer.invoke(Channels.tasks.listRunning);
      },
      listLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string }>> {
        return ipcRenderer.invoke(Channels.tasks.listLogHistory);
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
      onRunFinished(callback: (payload: PushMap['tasks:runFinished']) => void): () => void {
        return typedOn(Channels.tasks.runFinished, callback);
      },
      onRunStarted(callback: (payload: PushMap['tasks:runStarted']) => void): () => void {
        return typedOn(Channels.tasks.runStarted, callback);
      },
    },
    providers: {
      list(): Promise<Array<{ id: string; name: string; settingsView?: string }>> {
        return ipcRenderer.invoke(Channels.providers.list);
      },
      getStatusLine(providerId: string): Promise<string> {
        return ipcRenderer.invoke(Channels.providers.getStatusLine, providerId);
      },
      setDefault(providerId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.providers.setDefault, providerId);
      },
      onStateChanged(callback: (state: PushMap['provider:state-changed']) => void): () => void {
        return typedOn(Channels.providers.stateChanged, callback);
      },
    },
    agent: {
      createSession(opts?: { label?: string; prompt?: string; providerId?: string; files?: Array<{ type: 'file'; data: string; mimeType: string }> }): Promise<string> {
        return ipcRenderer.invoke(Channels.agent.createSession, opts);
      },
      sendMessage(text: string, options?: { streamingBehavior?: 'followUp'; files?: Array<{ type: 'file'; data: string; mimeType: string }> }): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.sendMessage, text, options);
      },
      abort(): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.abort);
      },
      closeSession(): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.closeSession);
      },
      loadSession(file: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.loadSession, file);
      },
      switchTo(sessionId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.switchTo, sessionId);
      },
      getSessionList(): Promise<unknown[]> {
        return ipcRenderer.invoke(Channels.agent.getSessionList);
      },
      setNotifyOnFinish(value: boolean): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.setNotifyOnFinish, value);
      },
      reconnect(): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.reconnect);
      },
      getSnapshot(): Promise<PushMap['agent:snapshot']> {
        return ipcRenderer.invoke(Channels.agent.getSnapshot);
      },
      onSnapshot(callback: (snapshot: PushMap['agent:snapshot']) => void): () => void {
        return typedOn(Channels.agent.snapshot, callback);
      },
      onStreaming(callback: (data: PushMap['agent:streaming']) => void): () => void {
        return typedOn(Channels.agent.streaming, callback);
      },
      disposeSession(file: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.disposeSession, file);
      },
      retryNow(): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.retryNow);
      },
    },
    traces: {
      list(sessionId: string): Promise<TraceEvent[]> {
        return ipcRenderer.invoke(Channels.traces.list, sessionId);
      },
    },
    zenMode: {
      toggle(): Promise<void> {
        return ipcRenderer.invoke(Channels.zenMode.toggle);
      },
      set(value: boolean): Promise<void> {
        return ipcRenderer.invoke(Channels.zenMode.set, value);
      },
      onChanged(callback: (isZen: PushMap['zenMode:changed']) => void): () => void {
        return typedOn(Channels.zenMode.changed, callback);
      },
    },
    agentSidebar: {
      getInstalled(): Promise<Array<{ path: string; name: string; active: boolean; initialized: boolean }>> {
        return ipcRenderer.invoke(Channels.agentSidebar.getInstalled);
      },
      switch(agentRoot: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agentSidebar.switch, agentRoot);
      },
      add(): Promise<string | null> {
        return ipcRenderer.invoke(Channels.agentSidebar.add);
      },
      addFromFile(): Promise<string | null> {
        return ipcRenderer.invoke(Channels.agentSidebar.addFromFile);
      },
      remove(agentRoot: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agentSidebar.remove, agentRoot);
      },
      showContextMenu(agentRoot: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agentSidebar.showContextMenu, agentRoot);
      },
      reorder(fromIndex: number, toIndex: number): Promise<void> {
        return ipcRenderer.invoke(Channels.agentSidebar.reorder, fromIndex, toIndex);
      },
      onSwitched(callback: (data: PushMap['agent-sidebar:switched']) => void): () => void {
        return typedOn(Channels.agentSidebar.switched, callback);
      },
    },
  } satisfies AppIpc;

  contextBridge.exposeInMainWorld('ipc', api);
}

// --- agentview:// — expose window.agentwfy (flat API, agent tools subset only) ---

if (isAgentView) {
  let runtimeFunctionNames: string[] = [];
  try {
    runtimeFunctionNames = ipcRenderer.sendSync(Channels.runtimeFunctions.methods) ?? [];
  } catch {
    // Silently continue — if sendSync throws (e.g. sender context gone),
    // leaving runtimeFunctionNames empty is safer than crashing the preload.
  }

  const runtimeFunctions: Record<string, Function> = {};
  for (const name of runtimeFunctionNames) {
    runtimeFunctions[name] = (params: unknown) =>
      ipcRenderer.invoke(Channels.runtimeFunctions.call, name, params);
  }

  contextBridge.exposeInMainWorld('agentwfy', {
    ...runtimeFunctions,
    requestInstallAgent(filePath: string): Promise<{ installed: boolean; agentRoot?: string }> {
      return ipcRenderer.invoke(Channels.agents.requestInstall, filePath);
    },
    fetch(params: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
      return ipcRenderer.invoke(Channels.views.fetch, params);
    },
  });
}
