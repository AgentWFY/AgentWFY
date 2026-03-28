import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { WRITE_RE, normalizeSqlRows, normalizeParams } from './sqlite.js';
import type { SqlExecutionRequest, OnDbChange } from './sqlite.js';

const DDL_RE = /^\s*(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i;

const AGENT_DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
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
  name TEXT PRIMARY KEY,
  value TEXT,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0.0',
  code TEXT NOT NULL,
  author TEXT,
  repository TEXT,
  license TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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
CREATE TEMP TRIGGER IF NOT EXISTS plugins_insert AFTER INSERT ON plugins BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('plugins', NEW.id, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS plugins_update AFTER UPDATE ON plugins BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('plugins', NEW.id, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS plugins_delete AFTER DELETE ON plugins BEGIN
  INSERT INTO _changes (table_name, row_id, op) VALUES ('plugins', OLD.id, 'delete');
END;
`;

// Block agent from writing to system.* and plugin.* docs (created as TEMP so
// they don't interfere with our own upserts on next launch)
const SYSTEM_DOCS_GUARD_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_insert BEFORE INSERT ON docs
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR NEW.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* docs are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_update BEFORE UPDATE ON docs
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR OLD.name = 'system' OR OLD.name LIKE 'system.%'
  OR NEW.name LIKE 'plugin.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* docs are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _docs_system_guard_delete BEFORE DELETE ON docs
WHEN OLD.name = 'system' OR OLD.name LIKE 'system.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* docs are read-only');
END;
`;

// Block agent from writing to plugins table
const PLUGINS_TABLE_GUARD_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS plugins_guard_insert BEFORE INSERT ON plugins
BEGIN
  SELECT RAISE(ABORT, 'plugins table is read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS plugins_guard_update BEFORE UPDATE ON plugins
BEGIN
  SELECT RAISE(ABORT, 'plugins table is read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS plugins_guard_delete BEFORE DELETE ON plugins
BEGIN
  SELECT RAISE(ABORT, 'plugins table is read-only');
END;
`;

// Block agent from writing to system.* and plugin.* views
const SYSTEM_VIEWS_GUARD_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS _views_system_guard_insert BEFORE INSERT ON views
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR NEW.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* views are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _views_system_guard_update BEFORE UPDATE ON views
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR OLD.name = 'system' OR OLD.name LIKE 'system.%'
  OR NEW.name LIKE 'plugin.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* views are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _views_system_guard_delete BEFORE DELETE ON views
WHEN OLD.name = 'system' OR OLD.name LIKE 'system.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* views are read-only');
END;
`;

// Enforce view name format: lowercase letters, digits, dots, hyphens, underscores only
const VIEW_NAME_FORMAT_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS _views_name_format_insert BEFORE INSERT ON views
WHEN NEW.name GLOB '*[^a-z0-9._-]*'
BEGIN
  SELECT RAISE(ABORT, 'view name must contain only lowercase letters, digits, dots, hyphens, and underscores');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _views_name_format_update BEFORE UPDATE OF name ON views
WHEN NEW.name GLOB '*[^a-z0-9._-]*'
BEGIN
  SELECT RAISE(ABORT, 'view name must contain only lowercase letters, digits, dots, hyphens, and underscores');
END;
`;

// Block agent from inserting/deleting system.* and plugin.* config, but allow UPDATE
const SYSTEM_CONFIG_GUARD_SQL = `
CREATE TEMP TRIGGER IF NOT EXISTS _config_system_guard_insert BEFORE INSERT ON config
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR NEW.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* config cannot be inserted');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _config_system_guard_delete BEFORE DELETE ON config
WHEN OLD.name = 'system' OR OLD.name LIKE 'system.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* config cannot be deleted');
END;
`;

const DROP_GUARDS_SQL = `
DROP TRIGGER IF EXISTS plugins_guard_insert;
DROP TRIGGER IF EXISTS plugins_guard_update;
DROP TRIGGER IF EXISTS plugins_guard_delete;
DROP TRIGGER IF EXISTS _docs_system_guard_insert;
DROP TRIGGER IF EXISTS _docs_system_guard_update;
DROP TRIGGER IF EXISTS _docs_system_guard_delete;
DROP TRIGGER IF EXISTS _views_system_guard_insert;
DROP TRIGGER IF EXISTS _views_system_guard_update;
DROP TRIGGER IF EXISTS _views_system_guard_delete;
DROP TRIGGER IF EXISTS _views_name_format_insert;
DROP TRIGGER IF EXISTS _views_name_format_update;
DROP TRIGGER IF EXISTS _config_system_guard_insert;
DROP TRIGGER IF EXISTS _config_system_guard_delete;
`;

interface SystemDataSync<T extends { name: string }> {
  jsonPath: string;
  selectSql: string;
  upsertSql: string;
  hasChanged: (item: T, existing: Record<string, unknown>) => boolean;
  bindUpsert: (item: T) => (string | number | null)[];
}

class AgentDb {
  private db: DatabaseSync;

  constructor(opts: { dbPath: string; systemDocsPath: string; systemViewsPath: string; systemConfigPath: string }) {
    this.db = new DatabaseSync(opts.dbPath);
    this.init(opts);
  }

  /** Generic sync: read JSON, diff against DB, upsert/delete in a transaction. */
  private syncSystemData<T extends { name: string }>(spec: SystemDataSync<T>): void {
    const items: T[] = JSON.parse(fs.readFileSync(spec.jsonPath, 'utf-8'));

    const rows = this.db.prepare(spec.selectSql).all() as Record<string, unknown>[];
    const existing = new Map(rows.map(r => [r.name as string, r]));

    const toUpsert = items.filter(item => {
      const ex = existing.get(item.name);
      return !ex || spec.hasChanged(item, ex);
    });
    const itemNames = new Set(items.map(i => i.name));
    const toDelete = rows.filter(r => !itemNames.has(r.name as string));

    if (toUpsert.length === 0 && toDelete.length === 0) return;

    const upsert = this.db.prepare(spec.upsertSql);
    const del = this.db.prepare('DELETE FROM ' + spec.selectSql.match(/FROM (\w+)/i)![1] + ' WHERE name = ?');
    this.db.exec('BEGIN');
    for (const item of toUpsert) upsert.run(...spec.bindUpsert(item));
    for (const row of toDelete) del.run(row.name as string);
    this.db.exec('COMMIT');
  }

  private init(opts: { systemDocsPath: string; systemViewsPath: string; systemConfigPath: string }): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(AGENT_DB_SCHEMA_SQL);

    this.syncSystemData<{ name: string; content: string }>({
      jsonPath: opts.systemDocsPath,
      selectSql: "SELECT name, content FROM docs WHERE name = 'system' OR name LIKE 'system.%'",
      upsertSql: `INSERT INTO docs (name, content, updated_at) VALUES (?, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = unixepoch()`,
      hasChanged: (doc, ex) => ex.content !== doc.content,
      bindUpsert: (doc) => [doc.name, doc.content],
    });

    this.syncSystemData<{ name: string; title: string; content: string }>({
      jsonPath: opts.systemViewsPath,
      selectSql: "SELECT name, title, content FROM views WHERE name LIKE 'system.%'",
      upsertSql: `INSERT INTO views (name, title, content, updated_at) VALUES (?, ?, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET title = excluded.title, content = excluded.content, updated_at = unixepoch()`,
      hasChanged: (v, ex) => ex.title !== v.title || ex.content !== v.content,
      bindUpsert: (v) => [v.name, v.title, v.content],
    });

    this.syncSystemData<{ name: string; description: string }>({
      jsonPath: opts.systemConfigPath,
      selectSql: "SELECT name, description FROM config WHERE name LIKE 'system.%'",
      upsertSql: `INSERT INTO config (name, value, description) VALUES (?, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET description = excluded.description`,
      hasChanged: (item, ex) => ex.description !== item.description,
      bindUpsert: (item) => [item.name, item.description],
    });

    this.db.exec(CHANGE_TRACKING_SQL);
    this.db.exec(SYSTEM_DOCS_GUARD_SQL);
    this.db.exec(SYSTEM_VIEWS_GUARD_SQL);
    this.db.exec(VIEW_NAME_FORMAT_SQL);
    this.db.exec(SYSTEM_CONFIG_GUARD_SQL);
    this.db.exec(PLUGINS_TABLE_GUARD_SQL);
  }

  getEnabledPlugins(): Array<{ name: string; description: string; version: string; code: string }> {
    return this.db.prepare(
      'SELECT name, description, version, code FROM plugins WHERE enabled = 1'
    ).all() as Array<{ name: string; description: string; version: string; code: string }>;
  }

  getPlugin(name: string): { name: string; description: string; version: string; code: string } | undefined {
    const rows = this.db.prepare(
      'SELECT name, description, version, code FROM plugins WHERE name = ?'
    ).all(name) as Array<{ name: string; description: string; version: string; code: string }>;
    return rows[0];
  }

  getPluginInfo(name: string): { name: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number } | undefined {
    const rows = this.db.prepare(
      'SELECT name, description, version, author, repository, license, enabled FROM plugins WHERE name = ?'
    ).all(name) as Array<{ name: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
    return rows[0];
  }

  listPlugins(): Array<{ name: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }> {
    return this.db.prepare(
      'SELECT name, description, version, author, repository, license, enabled FROM plugins ORDER BY name'
    ).all() as Array<{ name: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
  }

  togglePlugin(name: string, enabled: boolean): void {
    this.adminWrite(() => {
      this.db.prepare(
        'UPDATE plugins SET enabled = ?, updated_at = unixepoch() WHERE name = ?'
      ).run(enabled ? 1 : 0, name);    });
  }

  installPlugins(
    plugins: Array<{ name: string; description: string; version: string; code: string; author?: string | null; repository?: string | null; license?: string | null }>,
    docs: Array<{ name: string; content: string }>,
    views: Array<{ name: string; title: string; content: string }>,
    config: Array<{ name: string; value: string | null; description: string }>,
  ): void {
    this.adminWrite(() => {
      const upsertPlugin = this.db.prepare(`
        INSERT INTO plugins (name, description, version, code, author, repository, license, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            version = excluded.version,
            code = excluded.code,
            author = excluded.author,
            repository = excluded.repository,
            license = excluded.license,
            updated_at = unixepoch()
      `);
      const upsertDoc = this.db.prepare(`
        INSERT INTO docs (name, content, updated_at)
          VALUES (?, ?, unixepoch())
          ON CONFLICT(name) DO UPDATE SET
            content = excluded.content,
            updated_at = unixepoch()
      `);
      const upsertView = this.db.prepare(`
        INSERT INTO views (name, title, content, updated_at)
          VALUES (?, ?, ?, unixepoch())
          ON CONFLICT(name) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            updated_at = unixepoch()
      `);
      const upsertConfig = this.db.prepare(`
        INSERT INTO config (name, value, description)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description
      `);

      this.db.exec('BEGIN');
      for (const p of plugins) {
        upsertPlugin.run(p.name, p.description, p.version, p.code, p.author ?? null, p.repository ?? null, p.license ?? null);
      }
      for (const d of docs) {
        upsertDoc.run(d.name, d.content);
      }
      for (const v of views) {
        upsertView.run(v.name, v.title, v.content);
      }
      for (const c of config) {
        upsertConfig.run(c.name, c.value, c.description);
      }
      this.db.exec('COMMIT');
    });
  }

  uninstallPlugin(name: string): void {
    this.adminWrite(() => {
      this.db.exec('BEGIN');
      this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
      this.db.prepare(
        "DELETE FROM docs WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.prepare(
        "DELETE FROM views WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.prepare(
        "DELETE FROM config WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.exec('COMMIT');
    });
  }

  private adminWrite(fn: () => void): void {
    this.db.exec(DROP_GUARDS_SQL);
    try {
      fn();
    } finally {
      this.db.exec(SYSTEM_DOCS_GUARD_SQL);
      this.db.exec(SYSTEM_VIEWS_GUARD_SQL);
      this.db.exec(SYSTEM_CONFIG_GUARD_SQL);
      this.db.exec(PLUGINS_TABLE_GUARD_SQL);
    }
  }

  run(request: SqlExecutionRequest, onDbChange?: OnDbChange): unknown[] {
    if (DDL_RE.test(request.sql)) {
      throw new Error('Schema modifications (CREATE/ALTER/DROP TABLE/INDEX/TRIGGER/VIEW) are not allowed on the agent database');
    }

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
  const systemDocsPath = path.join(import.meta.dirname, '..', 'system-docs.json');
  const systemViewsPath = path.join(import.meta.dirname, '..', 'system-views.json');
  const systemConfigPath = path.join(import.meta.dirname, '..', 'system-config.json');

  conn = new AgentDb({ dbPath: agentDbPath, systemDocsPath, systemViewsPath, systemConfigPath });
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
