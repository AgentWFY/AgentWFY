import { runAgentDbSql, runSqliteFileSql, type SqlExecutionRequest, type OnDbChange } from './sqlite.js';
import { resolveSqliteFilePath } from './paths.js';

export type SqlTarget = 'agent' | 'sqlite-file';

export interface RunSqlRequest extends SqlExecutionRequest {
  target: SqlTarget;
  path?: string;
  description?: string;
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

export async function routeSqlRequest(dataDir: string, request: RunSqlRequest, onDbChange?: OnDbChange): Promise<unknown[]> {
  if (request.target === 'agent') {
    return runAgentDbSql(dataDir, request, onDbChange);
  }

  const sqlitePath = await resolveSqliteFilePath(dataDir, request.path || '');
  return runSqliteFileSql(sqlitePath, request);
}
