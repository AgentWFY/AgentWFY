import { runAgentDbSql, type SqlExecutionRequest } from './sqlite.js';

export type SqlTarget = 'agent' | 'sqlite-file';

export interface RunSqlRequest extends SqlExecutionRequest {
  target: SqlTarget;
  path?: string;
  description?: string;
}

// Host-injected handler for the Node-only `sqlite-file` target. `sqlite-file.ts`
// installs it on Node; a host without arbitrary on-disk .sqlite files leaves it
// unset, so that target throws there. Keeps this router node-free.
export type SqliteFileSqlHandler = (dataDir: string, request: RunSqlRequest) => Promise<unknown[]>;

let sqliteFileSqlHandler: SqliteFileSqlHandler | null = null;

export function configureSqliteFileSql(handler: SqliteFileSqlHandler): void {
  sqliteFileSqlHandler = handler;
}

function isSqlTarget(value: unknown): value is SqlTarget {
  return value === 'agent' || value === 'sqlite-file';
}

export function parseRunSqlRequest(payload: unknown): RunSqlRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid runSql payload: expected an object');
  }

  const raw = payload as Record<string, unknown>;
  if (!isSqlTarget(raw.target)) {
    throw new Error('Invalid runSql payload: target must be "agent" or "sqlite-file"');
  }

  if (typeof raw.sql !== 'string' || raw.sql.trim().length === 0) {
    throw new Error('Invalid runSql payload: sql must be a non-empty string');
  }

  if (typeof raw.params !== 'undefined' && !Array.isArray(raw.params)) {
    throw new Error('Invalid runSql payload: params must be an array when provided');
  }

  if (typeof raw.path !== 'undefined' && typeof raw.path !== 'string') {
    throw new Error('Invalid runSql payload: path must be a string when provided');
  }

  if (typeof raw.description !== 'undefined' && typeof raw.description !== 'string') {
    throw new Error('Invalid runSql payload: description must be a string when provided');
  }

  return {
    target: raw.target,
    path: raw.path as string | undefined,
    sql: raw.sql,
    params: raw.params as unknown[] | undefined,
    description: raw.description as string | undefined,
  };
}

export async function routeSqlRequest(dataDir: string, request: RunSqlRequest): Promise<unknown[]> {
  if (request.target === 'agent') {
    return runAgentDbSql(dataDir, request);
  }

  if (!sqliteFileSqlHandler) {
    throw new Error('runSql target "sqlite-file" is not supported on this host');
  }
  return sqliteFileSqlHandler(dataDir, request);
}
