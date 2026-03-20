import { contextBridge, ipcRenderer } from 'electron';

const Channels = {
  files: {
    read: 'files:read',
    write: 'files:write',
    writeBinary: 'files:writeBinary',
    edit: 'files:edit',
    ls: 'files:ls',
    mkdir: 'files:mkdir',
    remove: 'files:remove',
    find: 'files:find',
    grep: 'files:grep',
  },
  sql: {
    run: 'sql:run',
  },
  tabs: {
    getTabs: 'tabs:getTabs',
    openTab: 'tabs:openTab',
    closeTab: 'tabs:closeTab',
    selectTab: 'tabs:selectTab',
    reloadTab: 'tabs:reloadTab',
    captureTab: 'tabs:captureTab',
    getConsoleLogs: 'tabs:getConsoleLogs',
    execJs: 'tabs:execJs',
    mountView: 'tabs:mountView',
    updateViewBounds: 'tabs:updateViewBounds',
    destroyView: 'tabs:destroyView',
    showContextMenu: 'tabs:showContextMenu',
    viewEvent: 'tabs:viewEvent',
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
  bus: {
    publish: 'bus:publish',
    waitFor: 'bus:waitFor',
    waitForResolved: 'bus:waitForResolved',
    forwardPublish: 'bus:forwardPublish',
    forwardWaitFor: 'bus:forwardWaitFor',
    forwardSubscribe: 'bus:forwardSubscribe',
    forwardUnsubscribe: 'bus:forwardUnsubscribe',
    subscribeEvent: 'bus:subscribeEvent',
  },
  db: {
    changed: 'db:changed',
  },
  tasks: {
    start: 'tasks:start',
    stop: 'tasks:stop',
    listLogHistory: 'tasks:listLogHistory',
    listLogs: 'tasks:listLogs',
    readLog: 'tasks:readLog',
    writeLog: 'tasks:writeLog',
  },
  plugins: {
    call: 'plugin:call',
    methods: 'plugin:methods',
    install: 'plugin:install',
    uninstall: 'plugin:uninstall',
    requestInstall: 'plugin:requestInstall',
    requestToggle: 'plugin:requestToggle',
    requestUninstall: 'plugin:requestUninstall',
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
    spawnAgent: 'agent:spawnAgent',
    sendToAgent: 'agent:sendToAgent',
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

// --- Builder functions for shared domains ---

function buildFilesApi() {
  return {
    read(path: string, offset?: number, limit?: number): Promise<string> {
      return ipcRenderer.invoke(Channels.files.read, path, offset, limit);
    },
    write(path: string, content: string): Promise<string> {
      return ipcRenderer.invoke(Channels.files.write, path, content);
    },
    writeBinary(path: string, base64: string): Promise<string> {
      return ipcRenderer.invoke(Channels.files.writeBinary, path, base64);
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
      onForwardSubscribe(callback: (detail: { subId: string; topic: string }) => void): () => void {
        const handler = (_event: unknown, detail: { subId: string; topic: string }) => callback(detail);
        ipcRenderer.on(Channels.bus.forwardSubscribe, handler);
        return () => ipcRenderer.removeListener(Channels.bus.forwardSubscribe, handler);
      },
      onForwardUnsubscribe(callback: (detail: { subId: string }) => void): () => void {
        const handler = (_event: unknown, detail: { subId: string }) => callback(detail);
        ipcRenderer.on(Channels.bus.forwardUnsubscribe, handler);
        return () => ipcRenderer.removeListener(Channels.bus.forwardUnsubscribe, handler);
      },
      subscribeEvent(subId: string, data: unknown): void {
        ipcRenderer.send(Channels.bus.subscribeEvent, { subId, data });
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
    plugins: {
      call(method: string, params: unknown): Promise<unknown> {
        return ipcRenderer.invoke(Channels.plugins.call, method, params);
      },
      methods(): Promise<string[]> {
        return ipcRenderer.invoke(Channels.plugins.methods);
      },
      install(packagePath: string): Promise<{ installed: string[] }> {
        return ipcRenderer.invoke(Channels.plugins.install, packagePath);
      },
      uninstall(pluginName: string): Promise<void> {
        return ipcRenderer.invoke(Channels.plugins.uninstall, pluginName);
      },
    },
    tasks: {
      start(taskId: number, input?: unknown, origin?: unknown): Promise<{ runId: string }> {
        return ipcRenderer.invoke(Channels.tasks.start, taskId, input, origin);
      },
      stop(runId: string): Promise<void> {
        return ipcRenderer.invoke(Channels.tasks.stop, runId);
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
    },
  });
}

// --- agentview:// — expose window.agentwfy (flat API, agent tools subset only) ---

if (isAgentView) {
  const files = buildFilesApi();
  const agentTabs = buildAgentTabsApi();
  const busAgent = buildBusAgentApi();

  // Query plugin method names synchronously so they can be exposed as flat methods
  const pluginMethodNames: string[] = ipcRenderer.sendSync(Channels.plugins.methods) ?? [];
  const pluginFunctions: Record<string, Function> = {};
  for (const name of pluginMethodNames) {
    pluginFunctions[name] = (params: unknown) => ipcRenderer.invoke(Channels.plugins.call, name, params);
  }

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
      return ipcRenderer.invoke(Channels.agent.spawnAgent, prompt);
    },
    sendToAgent(agentId: string, message: string): Promise<void> {
      return ipcRenderer.invoke(Channels.agent.sendToAgent, agentId, message);
    },
    startTask(taskId: number, input?: unknown): Promise<{ runId: string }> {
      return ipcRenderer.invoke(Channels.tasks.start, taskId, input);
    },
    stopTask(runId: string): Promise<void> {
      return ipcRenderer.invoke(Channels.tasks.stop, runId);
    },
    ...pluginFunctions,
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke(Channels.dialog.openExternal, url);
    },
    requestInstallPlugin(packagePath: string): Promise<{ installed: string[] }> {
      return ipcRenderer.invoke(Channels.plugins.requestInstall, packagePath);
    },
    requestTogglePlugin(pluginName: string): Promise<{ toggled: boolean; enabled?: boolean }> {
      return ipcRenderer.invoke(Channels.plugins.requestToggle, pluginName);
    },
    requestUninstallPlugin(pluginName: string): Promise<{ uninstalled: boolean }> {
      return ipcRenderer.invoke(Channels.plugins.requestUninstall, pluginName);
    },
  });
}
