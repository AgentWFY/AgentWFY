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
    target: 'agent' | 'sqlite-file';
    // For target="sqlite-file", this path must resolve inside DATA_DIR and outside DATA_DIR/.agent.
    path?: string;
    sql: string;
    params?: any[];
    description?: string;
    confirmed?: boolean;
  }

  interface Window {
    electronDialog: {
      open(options: any): Promise<string[]>;
    };
    electronStore: {
      getItem<T = any>(key: string): Promise<T>;
      setItem<T = any>(key: string, value: T): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
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
      captureWindowPng(): Promise<{ path: string; base64: string }>;
      getConsoleLogs(since?: number): Promise<Array<{ level: string; message: string; timestamp: number }>>;
      onAgentDbChanged(callback: (detail: ElectronAgentDbChangedEvent) => void): () => void;
    };
    electronViewWatcher: {
      onFileChanged(callback: (detail: { path: string, event: string }) => void): () => void;
    };
    tradinglogViewBridge?: {
      runSql(request: ElectronRunSqlRequest): Promise<any>;
      mediaUrl(relativePath: string): string;
      installRunSqlEventShim(): void;
    };
  }
}

export {};
