declare global {
  interface ElectronRunSqlRequest {
    target?: 'agent' | 'sqlite-file';
    // For target="sqlite-file", this path must resolve inside DATA_DIR and outside DATA_DIR/.agentwfy.
    path?: string;
    sql: string;
    params?: unknown[];
    description?: string;
  }

  interface Window {
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
      openTab(request: { viewName?: string | number; filePath?: string; url?: string; title?: string }): Promise<void>;
      closeTab(request: { tabId: string }): Promise<void>;
      selectTab(request: { tabId: string }): Promise<void>;
      reloadTab(request: { tabId: string }): Promise<void>;
      captureTab(request: { tabId: string }): Promise<{ base64: string; mimeType: 'image/png' }>;
      getTabConsoleLogs(request: { tabId: string; since?: number; limit?: number }): Promise<Array<{ level: string; message: string; timestamp: number }>>;
      execTabJs(request: { tabId: string; code: string; timeoutMs?: number }): Promise<unknown>;
      publish(topic: string, data: unknown): Promise<void>;
      waitFor(topic: string, timeoutMs?: number): Promise<unknown>;
      spawnSession(prompt: string): Promise<{ sessionId: string }>;
      startTask(taskName: string, input?: unknown): Promise<{ runId: string }>;
      stopTask(runId: string): Promise<void>;
    };
  }
}

export {};
