import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { WRITE_RE, normalizeSqlRows, normalizeParams } from './sqlite.js';
import type { SqlExecutionRequest, OnDbChange } from './sqlite.js';

const AGENT_DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS _docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  preload INTEGER NOT NULL DEFAULT 0 CHECK(preload IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  timeout_ms INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('schedule', 'http', 'event')),
  config TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
CREATE TEMP TRIGGER IF NOT EXISTS _docs_insert AFTER INSERT ON _docs BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('docs', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _docs_update AFTER UPDATE ON _docs BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('docs', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _docs_delete AFTER DELETE ON _docs BEGIN
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
CREATE TEMP TRIGGER IF NOT EXISTS _triggers_insert AFTER INSERT ON triggers BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('triggers', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _triggers_update AFTER UPDATE ON triggers BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('triggers', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _triggers_delete AFTER DELETE ON triggers BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('triggers', OLD.id, 'delete');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _config_insert AFTER INSERT ON config BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('config', NEW.rowid, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _config_update AFTER UPDATE ON config BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('config', NEW.rowid, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _config_delete AFTER DELETE ON config BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('config', OLD.rowid, 'delete');
END;
`;

const DOCS_VIEW_SQL = `
CREATE TEMP VIEW docs AS
  SELECT id, name, content, preload, updated_at FROM _docs
  UNION ALL
  SELECT id, name, content, preload, updated_at FROM platform.docs
  WHERE name NOT IN (SELECT name FROM _docs);

CREATE TEMP TRIGGER docs_insert INSTEAD OF INSERT ON docs
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only')
    WHERE NEW.name LIKE 'system.%';
  INSERT INTO _docs (name, content, preload, updated_at)
    VALUES (NEW.name, NEW.content, NEW.preload, COALESCE(NEW.updated_at, unixepoch()));
END;

CREATE TEMP TRIGGER docs_update INSTEAD OF UPDATE ON docs
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only')
    WHERE NEW.name LIKE 'system.%' OR OLD.name LIKE 'system.%';
  UPDATE _docs SET name = NEW.name, content = NEW.content,
    preload = NEW.preload, updated_at = COALESCE(NEW.updated_at, unixepoch())
  WHERE id = OLD.id;
END;

CREATE TEMP TRIGGER docs_delete INSTEAD OF DELETE ON docs
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only')
    WHERE OLD.name LIKE 'system.%';
  DELETE FROM _docs WHERE id = OLD.id;
END;
`;

class AgentDb {
  private db: DatabaseSync;

  constructor(agentDbPath: string, platformDbPath: string) {
    this.db = new DatabaseSync(agentDbPath);
    this.init(platformDbPath);
  }

  private init(platformDbPath: string): void {
    this.db.exec('PRAGMA foreign_keys = ON;');

    // Migration: rename docs → _docs if needed
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('docs', '_docs')"
    ).all() as { name: string }[];
    const tableNames = new Set(tables.map(t => t.name));

    if (tableNames.has('docs') && !tableNames.has('_docs')) {
      this.db.exec('ALTER TABLE docs RENAME TO _docs;');
      this.db.exec("DELETE FROM _docs WHERE name LIKE 'system.%';");
    }

    this.db.exec(AGENT_DB_SCHEMA_SQL);
    this.db.exec(`ATTACH DATABASE '${platformDbPath.replace(/'/g, "''")}' AS platform;`);
    this.db.exec(CHANGE_TRACKING_SQL);
    this.db.exec(DOCS_VIEW_SQL);
  }

  run(request: SqlExecutionRequest, onDbChange?: OnDbChange): unknown[] {
    const params = normalizeParams(request.params);
    const trackChanges = onDbChange && WRITE_RE.test(request.sql);

    if (trackChanges) {
      this.db.exec('DELETE FROM _changes;');
    }

    const statement = this.db.prepare(request.sql);
    const rows = statement.all(...params as (null | number | bigint | string)[]);

    if (trackChanges) {
      const changes = this.db.prepare('SELECT table_name, row_id, op FROM _changes').all();
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
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}

// Module-level registry
const connections = new Map<string, AgentDb>();

export function getOrCreateAgentDb(dataDir: string): AgentDb {
  let conn = connections.get(dataDir);
  if (conn) return conn;

  const agentDir = path.join(dataDir, '.agentwfy');
  fs.mkdirSync(agentDir, { recursive: true });
  const agentDbPath = path.join(agentDir, 'agent.db');
  const platformDbPath = path.join(import.meta.dirname, 'platform.db');

  conn = new AgentDb(agentDbPath, platformDbPath);
  connections.set(dataDir, conn);
  return conn;
}

export function closeAgentDb(dataDir: string): void {
  const conn = connections.get(dataDir);
  if (conn) {
    conn.close();
    connections.delete(dataDir);
  }
}
