import { contextBridge, ipcRenderer } from 'electron';

const Channels = {
  sql: {
    run: 'sql:run',
  },
  tabs: {
    openTab: 'tabs:openTab',
    closeTab: 'tabs:closeTab',
    selectTab: 'tabs:selectTab',
    mountView: 'tabs:mountView',
    updateViewBounds: 'tabs:updateViewBounds',
    destroyView: 'tabs:destroyView',
    showContextMenu: 'tabs:showContextMenu',
    viewEvent: 'tabs:viewEvent',
    stateChanged: 'tabs:stateChanged',
    getState: 'tabs:getState',
    reorderTabs: 'tabs:reorderTabs',
    togglePin: 'tabs:togglePin',
    revealTab: 'tabs:revealTab',
    toggleDevTools: 'tabs:toggleDevTools',
  },
  sessions: {
    list: 'sessions:list',
    read: 'sessions:read',
    write: 'sessions:write',
  },
  store: {
    get: 'store:get',
    set: 'store:set',
    remove: 'store:remove',
  },
  dialog: {
    open: 'dialog:open',
    openExternal: 'dialog:openExternal',
  },
  db: {
    changed: 'db:changed',
  },
  tasks: {
    start: 'tasks:start',
    stop: 'tasks:stop',
    listRunning: 'tasks:listRunning',
    listLogHistory: 'tasks:listLogHistory',
    listLogs: 'tasks:listLogs',
    readLog: 'tasks:readLog',
    writeLog: 'tasks:writeLog',
    runFinished: 'tasks:runFinished',
  },
  providers: {
    list: 'provider:list',
    getStatusLine: 'provider:get-status-line',
  },
  agent: {
    createSession: 'agent:createSession',
    sendMessage: 'agent:sendMessage',
    abort: 'agent:abort',
    closeSession: 'agent:closeSession',
    loadSession: 'agent:loadSession',
    switchTo: 'agent:switchTo',
    getSessionList: 'agent:getSessionList',
    setNotifyOnFinish: 'agent:setNotifyOnFinish',
    reconnect: 'agent:reconnect',
    getSnapshot: 'agent:getSnapshot',
    snapshot: 'agent:snapshot',
    streaming: 'agent:streaming',
    spawnSession: 'agent:spawnSession',
    sendToSession: 'agent:sendToSession',
    disposeSession: 'agent:disposeSession',
    retryNow: 'agent:retryNow',
  },
  runtimeFunctions: {
    methods: 'runtime-functions:methods',
    call: 'runtime-functions:call',
  },
  agents: {
    requestInstall: 'agents:requestInstall',
  },
  views: {
    fetch: 'views:fetch',
  },
  agentSidebar: {
    getInstalled: 'agent-sidebar:getInstalled',
    switch: 'agent-sidebar:switch',
    add: 'agent-sidebar:add',
    addFromFile: 'agent-sidebar:addFromFile',
    remove: 'agent-sidebar:remove',
    switched: 'agent-sidebar:switched',
    showContextMenu: 'agent-sidebar:showContextMenu',
    reorder: 'agent-sidebar:reorder',
  },
} as const;

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

  contextBridge.exposeInMainWorld('ipc', {
    sql,
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
      onStateChanged(callback: (state: unknown) => void): () => void {
        const handler = (_event: unknown, state: unknown) => callback(state);
        ipcRenderer.on(Channels.tabs.stateChanged, handler);
        return () => ipcRenderer.removeListener(Channels.tabs.stateChanged, handler);
      },
      getTabState(): Promise<unknown> {
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
    db: {
      onDbChanged(callback: (detail: { table: string; rowId: number; op: 'insert' | 'update' | 'delete' }) => void): () => void {
        const handler = (_event: unknown, detail: { table: string; rowId: number; op: 'insert' | 'update' | 'delete' }) => callback(detail);
        ipcRenderer.on(Channels.db.changed, handler);
        return () => ipcRenderer.removeListener(Channels.db.changed, handler);
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
      return ipcRenderer.invoke('app:restart');
    },
    stop(): Promise<void> {
      return ipcRenderer.invoke('app:stop');
    },
    reloadRenderer(): Promise<void> {
      return ipcRenderer.invoke('app:reloadRenderer');
    },
    getAgentRoot(): Promise<string | null> {
      return ipcRenderer.invoke('app:getAgentRoot');
    },
    getHttpApiPort(): Promise<number | null> {
      return ipcRenderer.invoke('app:getHttpApiPort');
    },
    getBackupStatus(): Promise<{ currentVersion: number | null; modified: boolean; latestBackup: { version: number; timestamp: string } | null } | null> {
      return ipcRenderer.invoke('app:getBackupStatus');
    },
    getDefaultView(): Promise<{ viewId: number; title: string; viewUpdatedAt: number } | null> {
      return ipcRenderer.invoke('app:getDefaultView');
    },
    tasks: {
      start(taskId: number, input?: unknown, origin?: unknown): Promise<{ runId: string }> {
        return ipcRenderer.invoke(Channels.tasks.start, taskId, input, origin);
      },
      stop(runId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tasks.stop, runId);
      },
      listRunning(): Promise<Array<{ runId: string; taskId: number; title: string; status: string; origin: unknown; startedAt: number }>> {
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
      onRunFinished(callback: (payload: unknown) => void): () => void {
        const handler = (_event: unknown, payload: unknown) => callback(payload);
        ipcRenderer.on(Channels.tasks.runFinished, handler);
        return () => ipcRenderer.removeListener(Channels.tasks.runFinished, handler);
      },
    },
    providers: {
      list(): Promise<Array<{ id: string; name: string; settingsView?: string }>> {
        return ipcRenderer.invoke(Channels.providers.list);
      },
      getStatusLine(providerId: string): Promise<string> {
        return ipcRenderer.invoke(Channels.providers.getStatusLine, providerId);
      },
    },
    agent: {
      createSession(opts?: { label?: string; prompt?: string; providerId?: string }): Promise<string> {
        return ipcRenderer.invoke(Channels.agent.createSession, opts);
      },
      sendMessage(text: string, options?: { streamingBehavior?: 'followUp' }): Promise<void> {
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
      getSnapshot(): Promise<unknown> {
        return ipcRenderer.invoke(Channels.agent.getSnapshot);
      },
      onSnapshot(callback: (snapshot: unknown) => void): () => void {
        const handler = (_event: unknown, snapshot: unknown) => callback(snapshot);
        ipcRenderer.on(Channels.agent.snapshot, handler);
        return () => ipcRenderer.removeListener(Channels.agent.snapshot, handler);
      },
      onStreaming(callback: (data: unknown) => void): () => void {
        const handler = (_event: unknown, data: unknown) => callback(data);
        ipcRenderer.on(Channels.agent.streaming, handler);
        return () => ipcRenderer.removeListener(Channels.agent.streaming, handler);
      },
      disposeSession(file: string): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.disposeSession, file);
      },
      retryNow(): Promise<void> {
        return ipcRenderer.invoke(Channels.agent.retryNow);
      },
    },
    zenMode: {
      changed(isZen: boolean): void {
        ipcRenderer.send('zenMode:changed', isZen);
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
      reorder(agentPaths: string[]): Promise<void> {
        return ipcRenderer.invoke(Channels.agentSidebar.reorder, agentPaths);
      },
      onSwitched(callback: (data: { agentRoot: string; agents: Array<{ path: string; name: string; active: boolean; initialized: boolean }> }) => void): () => void {
        const handler = (_event: unknown, data: { agentRoot: string; agents: Array<{ path: string; name: string; active: boolean; initialized: boolean }> }) => callback(data);
        ipcRenderer.on(Channels.agentSidebar.switched, handler);
        return () => ipcRenderer.removeListener(Channels.agentSidebar.switched, handler);
      },
    },
  });
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
