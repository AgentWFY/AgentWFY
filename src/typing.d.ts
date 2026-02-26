declare global {
  interface ElectronAgentDbChange {
    seq: number;
    table: string;
    rowId: number;
    op: 'insert' | 'update' | 'delete';
    changedAt: number;
  }

  interface ElectronAgentDbChangedEvent {
    cursor: number;
    changes: ElectronAgentDbChange[];
  }

  interface ElectronRunSqlRequest {
    target?: 'agent' | 'sqlite-file';
    // For target="sqlite-file", this path must resolve inside DATA_DIR and outside DATA_DIR/.agent.
    path?: string;
    sql: string;
    params?: any[];
    description?: string;
    confirmed?: boolean;
  }

  interface Window {
    electronAgentTools: {
      // Paths are resolved relative to the selected DATA_DIR.
      // Access to DATA_DIR/.agent/** is denied for file-tool operations.
      read(path: string, offset?: number, limit?: number): Promise<string>;
      write(path: string, content: string): Promise<string>;
      edit(path: string, oldText: string, newText: string): Promise<string>;
      ls(path?: string, limit?: number): Promise<string>;
      mkdir(path: string, recursive?: boolean): Promise<void>;
      remove(path: string, recursive?: boolean): Promise<void>;
      find(pattern: string, path?: string, limit?: number): Promise<string>;
      grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
      runSql(request: ElectronRunSqlRequest): Promise<any>;
      captureView(request: { viewId: string | number }): Promise<{ base64: string; mimeType: 'image/png' }>;
      getViewConsoleLogs(request: { viewId: string | number; since?: number; limit?: number }): Promise<Array<{ level: string; message: string; timestamp: number }>>;
      execViewJs(request: { viewId: string | number; code: string; timeoutMs?: number }): Promise<any>;
    };
    electronClientTools?: {
      openDialog(options: any): Promise<string[]>;
      getStoreItem<T = any>(key: string): Promise<T>;
      setStoreItem<T = any>(key: string, value: T): Promise<void>;
      removeStoreItem(key: string): Promise<void>;
      listSessions(limit?: number): Promise<Array<{ name: string; updatedAt: number }>>;
      readSession(sessionFileName: string): Promise<string>;
      writeSession(sessionFileName: string, content: string): Promise<void>;
      readAuthConfig(): Promise<string>;
      writeAuthConfig(content: string): Promise<void>;
      readLegacyApiKey(): Promise<string>;
      mountExternalView(request: { tabId: string; viewId: string; src: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }): Promise<void>;
      updateExternalViewBounds(request: { tabId: string; bounds: { x: number; y: number; width: number; height: number }; visible: boolean }): Promise<void>;
      destroyExternalView(request: { tabId: string }): Promise<void>;
      onExternalViewEvent(callback: (detail: { tabId: string; type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load'; errorCode?: number; errorDescription?: string }) => void): () => void;
      onAgentDbChanged(callback: (detail: ElectronAgentDbChangedEvent) => void): () => void;
    };
  }
}

export {};
