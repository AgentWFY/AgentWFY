import { resolveAgentDbPath } from './path-policy';

interface StatementSyncLike {
  all(...params: unknown[]): unknown[];
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

type DatabaseSyncCtor = new (location: string) => DatabaseSyncLike;

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };


const AGENT_DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  preload INTEGER NOT NULL DEFAULT 0 CHECK(preload IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS db_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  changed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER IF NOT EXISTS views_db_changes_insert
AFTER INSERT ON views
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('views', NEW.id, 'insert', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS views_db_changes_update
AFTER UPDATE ON views
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('views', NEW.id, 'update', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS views_db_changes_delete
AFTER DELETE ON views
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('views', OLD.id, 'delete', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS docs_db_changes_insert
AFTER INSERT ON docs
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('docs', NEW.id, 'insert', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS docs_db_changes_update
AFTER UPDATE ON docs
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('docs', NEW.id, 'update', unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS docs_db_changes_delete
AFTER DELETE ON docs
BEGIN
  INSERT INTO db_changes (table_name, row_id, op, changed_at)
  VALUES ('docs', OLD.id, 'delete', unixepoch());
END;
`;

export interface SqlExecutionRequest {
  sql: string;
  params?: unknown[];
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

function normalizeSqlRows(rows: unknown[]): unknown[] {
  return rows.map((row) => normalizeSqlValue(row));
}

function normalizeParams(params: unknown[] | undefined): unknown[] {
  if (typeof params === 'undefined') {
    return [];
  }

  if (!Array.isArray(params)) {
    throw new Error('SQL params must be an array when provided');
  }

  return params;
}

function runSqliteQuery(dbPath: string, request: SqlExecutionRequest, initSql?: string): unknown[] {
  const params = normalizeParams(request.params);
  const db = new DatabaseSync(dbPath);

  try {
    if (initSql) {
      db.exec(initSql);
    }

    const statement = db.prepare(request.sql);
    const rows = statement.all(...params);
    return normalizeSqlRows(rows);
  } finally {
    db.close();
  }
}

export async function runAgentDbSql(dataDir: string, request: SqlExecutionRequest): Promise<unknown[]> {
  const dbPath = await resolveAgentDbPath(dataDir);
  return runSqliteQuery(dbPath, request, AGENT_DB_SCHEMA_SQL);
}

export async function runSqliteFileSql(sqlitePath: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return runSqliteQuery(sqlitePath, request);
}
