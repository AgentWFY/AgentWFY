import { DatabaseSync } from 'node:sqlite';
import { getOrCreateAgentDb } from './agent-db.js';

export interface SqlExecutionRequest {
  sql: string;
  params?: unknown[];
}

export interface AgentDbChange {
  table: string;
  rowId: string | number;
  op: 'insert' | 'update' | 'delete';
  /**
   * Previous primary-key value for update events that changed the replicated
   * row key. Mirrors use it to update the existing row instead of leaving the
   * old key behind.
   */
  previousRowId?: string | number;
  /**
   * Monotonic per-AgentDb version assigned by the daemon when the change is
   * drained. Increments by 1 for every emitted change. Mirrors use this to
   * sequence incremental application and to detect gaps that require a full
   * re-snapshot.
   *
   * Local agents (no remote mirror) just ignore it.
   */
  version: number;
  /**
   * Snapshot of the row at change time, for insert/update events. Absent
   * for deletes. When absent on a non-delete change, mirrors fall back to
   * a full snapshot.
   */
  row?: Record<string, unknown>;
}

const MUTATION_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

export function isPotentiallyMutatingSql(sql: string): boolean {
  return MUTATION_RE.test(stripLeadingSqlComments(sql));
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  while (true) {
    const next = rest.trimStart();
    if (next.startsWith('--')) {
      const newline = next.indexOf('\n');
      rest = newline === -1 ? '' : next.slice(newline + 1);
      continue;
    }
    if (next.startsWith('/*')) {
      const end = next.indexOf('*/', 2);
      rest = end === -1 ? '' : next.slice(end + 2);
      continue;
    }
    return next;
  }
}

function normalizeSqlValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeSqlValue(item));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = normalizeSqlValue(item);
    }
    return output;
  }

  return value;
}

export function normalizeSqlRows(rows: unknown[]): unknown[] {
  return rows.map((row) => normalizeSqlValue(row));
}

export function normalizeParams(params: unknown[] | undefined): unknown[] {
  if (typeof params === 'undefined') {
    return [];
  }

  if (!Array.isArray(params)) {
    throw new Error('SQL params must be an array when provided');
  }

  return params;
}

function runSqliteQuery(dbPath: string, request: SqlExecutionRequest): unknown[] {
  const params = normalizeParams(request.params);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  try {
    const statement = db.prepare(request.sql);
    const rows = statement.all(...params as (null | number | bigint | string)[]);
    return normalizeSqlRows(rows);
  } finally {
    db.close();
  }
}

export async function runAgentDbSql(dataDir: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return getOrCreateAgentDb(dataDir).run(request);
}

export async function runSqliteFileSql(sqlitePath: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return runSqliteQuery(sqlitePath, request);
}
