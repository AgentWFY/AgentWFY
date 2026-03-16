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

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
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

// Block agent from writing to system.* docs (created as TEMP so they don't
// interfere with our own upserts on next launch)
const SYSTEM_DOCS_GUARD_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_insert BEFORE INSERT ON docs
WHEN NEW.name LIKE 'system.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_update BEFORE UPDATE ON docs
WHEN NEW.name LIKE 'system.%' OR OLD.name LIKE 'system.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_delete BEFORE DELETE ON docs
WHEN OLD.name LIKE 'system.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* docs are read-only');
END;
`;

interface PlatformDoc {
  name: string;
  content: string;
}

class AgentDb {
  private db: DatabaseSync;

  constructor(agentDbPath: string, platformDocsPath: string) {
    this.db = new DatabaseSync(agentDbPath);
    this.init(platformDocsPath);
  }

  private init(platformDocsPath: string): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(AGENT_DB_SCHEMA_SQL);

    // Upsert platform docs and clean up stale ones in a single transaction
    const raw = fs.readFileSync(platformDocsPath, 'utf-8');
    const platformDocs: PlatformDoc[] = JSON.parse(raw);
    const upsert = this.db.prepare(`
      INSERT INTO docs (name, content, updated_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET
          content = excluded.content,
          updated_at = unixepoch()
    `);
    const placeholders = platformDocs.map(() => '?').join(', ');
    const deleteStale = this.db.prepare(
      `DELETE FROM docs WHERE name LIKE 'system.%' AND name NOT IN (${placeholders})`
    );
    this.db.exec('BEGIN');
    for (const doc of platformDocs) {
      upsert.run(doc.name, doc.content);
    }
    deleteStale.run(...platformDocs.map(d => d.name));
    this.db.exec('COMMIT');

    this.db.exec(CHANGE_TRACKING_SQL);
    this.db.exec(SYSTEM_DOCS_GUARD_SQL);
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
  const platformDocsPath = path.join(import.meta.dirname, 'platform-docs.json');

  conn = new AgentDb(agentDbPath, platformDocsPath);
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
