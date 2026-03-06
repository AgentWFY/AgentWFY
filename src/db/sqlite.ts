import { resolveAgentDbPath } from './paths';

interface StatementSyncLike {
  all(...params: unknown[]): unknown[];
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

type DatabaseSyncCtor = new (location: string) => DatabaseSyncLike;

// eslint-disable-next-line @typescript-eslint/no-require-imports
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

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  timeout_ms INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);
`;

const CHANGE_TRACKING_SQL = `
CREATE TEMP TABLE IF NOT EXISTS _changes (
  table_name TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL
);

CREATE TEMP TRIGGER IF NOT EXISTS _views_insert AFTER INSERT ON views BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('views', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _views_update AFTER UPDATE ON views BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('views', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _views_delete AFTER DELETE ON views BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('views', OLD.id, 'delete');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _docs_insert AFTER INSERT ON docs BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('docs', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _docs_update AFTER UPDATE ON docs BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('docs', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _docs_delete AFTER DELETE ON docs BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('docs', OLD.id, 'delete');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _tasks_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('tasks', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _tasks_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('tasks', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _tasks_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('tasks', OLD.id, 'delete');
END;
`;

export interface SqlExecutionRequest {
  sql: string;
  params?: unknown[];
}

export interface AgentDbChange {
  table: string;
  rowId: number;
  op: 'insert' | 'update' | 'delete';
}

export type OnDbChange = (change: AgentDbChange) => void;

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

function isWriteStatement(sql: string): boolean {
  return WRITE_RE.test(sql);
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

function runSqliteQuery(dbPath: string, request: SqlExecutionRequest, initSql?: string, onDbChange?: OnDbChange): unknown[] {
  const params = normalizeParams(request.params);
  const db = new DatabaseSync(dbPath);
  const trackChanges = onDbChange && isWriteStatement(request.sql);

  try {
    if (initSql) {
      db.exec(initSql);
    }

    if (trackChanges) {
      db.exec(CHANGE_TRACKING_SQL);
    }

    const statement = db.prepare(request.sql);
    const rows = statement.all(...params);

    if (trackChanges) {
      const changes = db.prepare('SELECT table_name, row_id, op FROM _changes').all();
      for (const raw of changes) {
        const change = raw as Record<string, unknown>;
        onDbChange({
          table: change.table_name as string,
          rowId: Number(change.row_id),
          op: change.op as 'insert' | 'update' | 'delete',
        });
      }
    }

    return normalizeSqlRows(rows);
  } finally {
    db.close();
  }
}

export async function runAgentDbSql(dataDir: string, request: SqlExecutionRequest, onDbChange?: OnDbChange): Promise<unknown[]> {
  const dbPath = await resolveAgentDbPath(dataDir);
  return runSqliteQuery(dbPath, request, AGENT_DB_SCHEMA_SQL, onDbChange);
}

export async function runSqliteFileSql(sqlitePath: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return runSqliteQuery(sqlitePath, request);
}
