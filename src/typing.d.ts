declare global {
  interface ElectronAgentDbChange {
    table: string;
    rowId: number;
    op: 'insert' | 'update' | 'delete';
  }

  interface ElectronRunSqlRequest {
    target?: 'agent' | 'sqlite-file';
    // For target="sqlite-file", this path must resolve inside DATA_DIR and outside DATA_DIR/.agentwfy.
    path?: string;
    sql: string;
    params?: unknown[];
    description?: string;
  }

  interface Window {
    electronClientTools?: {
      openDialog(options: Record<string, unknown>): Promise<string[]>;
      openUrlInDefaultBrowser(url: string): Promise<void>;
      getStoreItem<T = unknown>(key: string): Promise<T>;
      setStoreItem<T = unknown>(key: string, value: T): Promise<void>;
      removeStoreItem(key: string): Promise<void>;
      listSessions(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>;
      readSession(sessionFileName: string): Promise<string>;
      writeSession(sessionFileName: string, content: string): Promise<void>;
      readAuthConfig(): Promise<string>;
      writeAuthConfig(content: string): Promise<void>;
      readLegacyApiKey(): Promise<string>;
      mountTabView(request: { tabId: string; viewId: string; src: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean; tabType?: 'view' | 'file' | 'url' }): Promise<void>;
      updateTabViewBounds(request: { tabId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }): Promise<void>;
      destroyTabView(request: { tabId: string }): Promise<void>;
      onTabViewEvent(callback: (detail: { tabId: string; type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'; errorCode?: number; errorDescription?: string }) => void): () => void;
      onAgentDbChanged(callback: (detail: ElectronAgentDbChange) => void): () => void;
      taskStartTask(taskId: number): Promise<string>;
      taskStopTask(runId: string): Promise<void>;
      taskRunTask(taskId: number): Promise<string>;
      taskGetRuns(): Promise<unknown[]>;
      taskListLogHistory(): Promise<Array<{ file: string; updatedAt: number; taskName: string; status: string }>>;
      onTaskStateChanged(callback: (runs: unknown[]) => void): () => void;
    };
    agentwfy?: {
      read(path: string, offset?: number, limit?: number): Promise<string>;
      write(path: string, content: string): Promise<string>;
      edit(path: string, oldText: string, newText: string): Promise<string>;
      ls(path?: string, limit?: number): Promise<string>;
      mkdir(path: string, recursive?: boolean): Promise<void>;
      remove(path: string, recursive?: boolean): Promise<void>;
      find(pattern: string, path?: string, limit?: number): Promise<string>;
      grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
      runSql(request: ElectronRunSqlRequest): Promise<unknown>;
      getTabs(): Promise<{ tabs: Array<{ id: string; title: string; type: 'view' | 'file' | 'url'; target: string | number; viewUpdatedAt: number | null; viewChanged: boolean; pinned: boolean; selected: boolean }> }>;
      openTab(request: { viewId?: string | number; filePath?: string; url?: string; title?: string }): Promise<void>;
      closeTab(request: { tabId: string }): Promise<void>;
      selectTab(request: { tabId: string }): Promise<void>;
      reloadTab(request: { tabId: string }): Promise<void>;
      captureTab(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }>;
      getTabConsoleLogs(request: { tabId: string; since?: number; limit?: number }): Promise<Array<{ level: string; message: string; timestamp: number }>>;
      execTabJs(request: { tabId: string; code: string; timeoutMs?: number }): Promise<unknown>;
      publish(topic: string, data: unknown): Promise<void>;
      waitFor(topic: string, timeoutMs?: number): Promise<unknown>;
      spawnAgent(prompt: string): Promise<{ agentId: string }>;
      startTask(taskId: number, input?: unknown): Promise<{ runId: string }>;
      stopTask(runId: string): Promise<void>;
    };
  }
}

export {};
