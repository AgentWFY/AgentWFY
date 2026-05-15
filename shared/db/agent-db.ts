import { DatabaseSync, StatementSync, backup, constants } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { isPotentiallyMutatingSql, normalizeSqlRows, normalizeParams, SYNTHETIC_DB_TABLE } from './sqlite.js';
import type { SqlExecutionRequest, AgentDbChange } from './sqlite.js';

export interface AgentDbSnapshotResult {
  /** Version counter at the moment the snapshot read started — every change
   *  with `version <= snapshotVersion` is in the snapshot, every change with
   *  `version > snapshotVersion` is not. */
  version: number;
}

const PROTECTED_TABLES = new Set(['views', 'docs', 'tasks', 'triggers', 'config', 'plugins', 'modules']);

function isReservedNamespace(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower === 'system' || lower === 'plugin'
    || lower.startsWith('system.') || lower.startsWith('plugin.');
}

function isProtectedSchemaName(name: string | null | undefined): boolean {
  if (!name) return false;
  return PROTECTED_TABLES.has(name.toLowerCase()) || isReservedNamespace(name);
}

function guardSqlWithoutAuthorizer(sql: string): void {
  const normalized = sql.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').toLowerCase();
  if (/\b(attach|detach|alter|create|drop)\b/.test(normalized)) {
    throw new Error('DDL and ATTACH/DETACH require node:sqlite authorizer support in this runtime');
  }
  if (/\b(insert\s+into|update|delete\s+from)\s+plugins\b/.test(normalized)) {
    throw new Error('plugins table is read-only in this runtime');
  }
}

const RESERVED_NAME_PREDICATE = `(
  LOWER(name) IN ('system', 'plugin')
  OR LOWER(name) LIKE 'system.%'
  OR LOWER(name) LIKE 'plugin.%'
)`;

const RESERVED_SCHEMA_SCAN_SQL = `
  SELECT type, name FROM sqlite_master WHERE ${RESERVED_NAME_PREDICATE}
  UNION ALL
  SELECT type, name FROM sqlite_temp_master WHERE ${RESERVED_NAME_PREDICATE}
  LIMIT 1
`;

const DDL_SAVEPOINT = '_agent_ddl';

const AGENT_DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS views (
  name TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS docs (
  name TEXT NOT NULL PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS tasks (
  name TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  timeout_ms INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS triggers (
  name TEXT NOT NULL PRIMARY KEY,
  task_name TEXT NOT NULL REFERENCES tasks(name) ON DELETE CASCADE,
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
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TABLE IF NOT EXISTS plugins (
  name TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS modules (
  name TEXT NOT NULL PRIMARY KEY CHECK(name GLOB '*.js' OR name GLOB '*.css'),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK(typeof(updated_at) = 'integer' AND updated_at > 0)
);

CREATE TRIGGER IF NOT EXISTS modules_cleanup_on_view_delete AFTER DELETE ON views
BEGIN
  DELETE FROM modules WHERE name GLOB OLD.name || '.*';
END;

${['views', 'docs', 'tasks', 'triggers', 'config', 'plugins', 'modules'].map(t => makeAutoUpdatedAtTriggerSql(t)).join('\n')}
`;

export const CHANGE_TRACKED_TABLES = ['views', 'docs', 'tasks', 'triggers', 'config', 'plugins', 'modules'] as const;
const CHANGE_TRACKED_TABLE_SET = new Set<string>(CHANGE_TRACKED_TABLES);

function makeAutoUpdatedAtTriggerSql(table: string): string {
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_auto_updated_at AFTER UPDATE ON ${table}
BEGIN
  UPDATE ${table} SET updated_at = unixepoch() WHERE rowid = NEW.rowid;
END;`;
}

export function isReplicatedTable(table: string): boolean {
  return CHANGE_TRACKED_TABLE_SET.has(table);
}

function isUserTableMutationTarget(table: string): boolean {
  const lower = table.toLowerCase();
  if (lower === '_changes' || lower.startsWith('sqlite_')) return false;
  return !CHANGE_TRACKED_TABLE_SET.has(lower);
}

function sqlTargetsUntrackedTable(sql: string): boolean {
  const stripped = sql.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  const target =
    stripped.match(/^(?:insert|replace)\s+(?:or\s+\w+\s+)?into\s+([`"\[]?[\w.-]+[`"\]]?)/i)?.[1]
    ?? stripped.match(/^update\s+(?:or\s+\w+\s+)?([`"\[]?[\w.-]+[`"\]]?)/i)?.[1]
    ?? stripped.match(/^delete\s+from\s+([`"\[]?[\w.-]+[`"\]]?)/i)?.[1];
  if (!target) return false;
  const table = target.split('.').pop()?.replace(/^[`"\[]|[`"\]]$/g, '');
  return table ? isUserTableMutationTarget(table) : false;
}

const CHANGE_TRACKING_SQL = `
CREATE TEMP TABLE IF NOT EXISTS _changes (
  table_name TEXT NOT NULL,
  row_id NOT NULL,
  previous_row_id,
  op TEXT NOT NULL
);

${CHANGE_TRACKED_TABLES.map(t => `
CREATE TEMP TRIGGER IF NOT EXISTS _${t}_insert AFTER INSERT ON ${t} BEGIN
  INSERT INTO _changes (table_name, row_id, previous_row_id, op) VALUES ('${t}', NEW.name, NULL, 'insert');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _${t}_update AFTER UPDATE ON ${t} BEGIN
  INSERT INTO _changes (table_name, row_id, previous_row_id, op) VALUES ('${t}', NEW.name, OLD.name, 'update');
END;
CREATE TEMP TRIGGER IF NOT EXISTS _${t}_delete AFTER DELETE ON ${t} BEGIN
  INSERT INTO _changes (table_name, row_id, previous_row_id, op) VALUES ('${t}', OLD.name, OLD.name, 'delete');
END;`).join('\n')}
`;

// Block agent from writing to system.* and plugin.* rows (created as TEMP so
// they don't interfere with our own upserts on next launch)
function makeNamespaceGuardSql(table: string): string {
  return `
CREATE TEMP TRIGGER IF NOT EXISTS _${table}_system_guard_insert BEFORE INSERT ON ${table}
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR NEW.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* ${table} are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _${table}_system_guard_update BEFORE UPDATE ON ${table}
WHEN NEW.name = 'system' OR NEW.name LIKE 'system.%' OR OLD.name = 'system' OR OLD.name LIKE 'system.%'
  OR NEW.name LIKE 'plugin.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* ${table} are read-only');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _${table}_system_guard_delete BEFORE DELETE ON ${table}
WHEN OLD.name = 'system' OR OLD.name LIKE 'system.%' OR OLD.name LIKE 'plugin.%'
BEGIN
  SELECT RAISE(ABORT, 'system.* and plugin.* ${table} are read-only');
END;
`;
}

const NAMESPACE_GUARDED_TABLES = ['docs', 'views', 'modules', 'tasks', 'triggers'];

function makeNameFormatSql(table: string, glob: string, message: string): string {
  return `
CREATE TEMP TRIGGER IF NOT EXISTS _${table}_name_format_insert BEFORE INSERT ON ${table}
WHEN NEW.name GLOB '${glob}' OR NEW.name NOT GLOB '[a-z0-9]*'
BEGIN
  SELECT RAISE(ABORT, '${message}');
END;

CREATE TEMP TRIGGER IF NOT EXISTS _${table}_name_format_update BEFORE UPDATE OF name ON ${table}
WHEN NEW.name GLOB '${glob}' OR NEW.name NOT GLOB '[a-z0-9]*'
BEGIN
  SELECT RAISE(ABORT, '${message}');
END;
`;
}

const NAME_FORMAT_TABLES = ['views', 'docs', 'modules', 'config', 'tasks', 'triggers'];
// Plugin names: no dots (dots are namespace separators in plugin.* prefixes)
const PLUGIN_NAME_FORMAT_SQL = makeNameFormatSql('plugins', '*[^a-z0-9-]*', 'plugin name must contain only lowercase letters, digits, and hyphens');

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

const DROP_GUARDS_SQL = [
  ...NAMESPACE_GUARDED_TABLES.flatMap(t => [
    `DROP TRIGGER IF EXISTS _${t}_system_guard_insert;`,
    `DROP TRIGGER IF EXISTS _${t}_system_guard_update;`,
    `DROP TRIGGER IF EXISTS _${t}_system_guard_delete;`,
  ]),
  'DROP TRIGGER IF EXISTS _config_system_guard_insert;',
  'DROP TRIGGER IF EXISTS _config_system_guard_delete;',
  ...[...NAME_FORMAT_TABLES, 'plugins'].flatMap(t => [
    `DROP TRIGGER IF EXISTS _${t}_name_format_insert;`,
    `DROP TRIGGER IF EXISTS _${t}_name_format_update;`,
  ]),
].join('\n');

const ALL_GUARD_SQL = [
  ...NAMESPACE_GUARDED_TABLES.map(t => makeNamespaceGuardSql(t)),
  SYSTEM_CONFIG_GUARD_SQL,
  ...NAME_FORMAT_TABLES.map(t => makeNameFormatSql(t, '*[^a-z0-9._-]*', `${t.replace(/s$/, '')} name must contain only lowercase letters, digits, dots, hyphens, and underscores`)),
  PLUGIN_NAME_FORMAT_SQL,
];

interface SystemDataSync<T extends { name: string }> {
  jsonPath: string;
  selectSql: string;
  upsertSql: string;
  hasChanged: (item: T, existing: Record<string, unknown>) => boolean;
  bindUpsert: (item: T) => (string | number | null)[];
}

class AgentDb {
  private db: DatabaseSync;
  private changeListener: ((change: AgentDbChange) => void) | null = null;
  private authorizerAvailable = false;
  // Set by the authorizer when prepare() encounters a DDL action code; read
  // by run() to decide whether to wrap execution in a schema-guard savepoint.
  private prepareSawDdl = false;
  // Set by the authorizer when a statement writes outside the built-in
  // replicated table set. We still emit any built-in row changes, then append
  // a synthetic full-DB marker so mirrors refresh user-defined tables too.
  private prepareMutatedUntrackedTable = false;
  private reservedSchemaScan: StatementSync | null = null;
  // Monotonic counter for emitted change events. Used by remote mirrors to
  // sequence incremental application and detect gaps. The counter lives in
  // memory only — on process restart it resets, and clients detect this by
  // the WS connection dropping (they fetch a fresh snapshot on reconnect).
  private versionCounter = 0;
  // Row-fetch statements cached per replicated table. Built lazily because
  // some tables don't exist yet when the AgentDb is first constructed.
  private rowFetchStatements = new Map<string, StatementSync>();

  constructor(opts: {
    dbPath: string;
    systemDocsPath: string;
    systemViewsPath: string;
    systemConfigPath: string;
    syncSystemData?: boolean;
  }) {
    this.db = new DatabaseSync(opts.dbPath);
    this.init(opts);
  }

  setChangeListener(listener: (change: AgentDbChange) => void): void {
    this.changeListener = listener;
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

  private init(opts: { systemDocsPath: string; systemViewsPath: string; systemConfigPath: string; syncSystemData?: boolean }): void {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(AGENT_DB_SCHEMA_SQL);

    if (opts.syncSystemData !== false) {
      this.syncSystemData<{ name: string; content: string }>({
        jsonPath: opts.systemDocsPath,
        selectSql: "SELECT name, content FROM docs WHERE name = 'system' OR name LIKE 'system.%'",
        upsertSql: `INSERT INTO docs (name, content) VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
        hasChanged: (doc, ex) => ex.content !== doc.content,
        bindUpsert: (doc) => [doc.name, doc.content],
      });

      this.syncSystemData<{ name: string; title: string; content: string }>({
        jsonPath: opts.systemViewsPath,
        selectSql: "SELECT name, title, content FROM views WHERE name LIKE 'system.%'",
        upsertSql: `INSERT INTO views (name, title, content) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET title = excluded.title, content = excluded.content`,
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
    }

    this.db.exec(CHANGE_TRACKING_SQL);
    for (const sql of ALL_GUARD_SQL) this.db.exec(sql);
    this.installAuthorizer();
  }

  private installAuthorizer(): void {
    const setAuthorizer = (this.db as { setAuthorizer?: DatabaseSync['setAuthorizer'] }).setAuthorizer;
    if (typeof setAuthorizer !== 'function') {
      this.authorizerAvailable = false;
      return;
    }

    this.authorizerAvailable = true;
    const {
      SQLITE_OK, SQLITE_DENY,
      SQLITE_CREATE_TABLE, SQLITE_DROP_TABLE, SQLITE_ALTER_TABLE,
      SQLITE_CREATE_INDEX, SQLITE_DROP_INDEX,
      SQLITE_CREATE_TRIGGER, SQLITE_DROP_TRIGGER,
      SQLITE_CREATE_TEMP_TABLE, SQLITE_DROP_TEMP_TABLE,
      SQLITE_CREATE_TEMP_INDEX, SQLITE_DROP_TEMP_INDEX,
      SQLITE_CREATE_TEMP_TRIGGER, SQLITE_DROP_TEMP_TRIGGER,
      SQLITE_CREATE_VIEW, SQLITE_DROP_VIEW,
      SQLITE_CREATE_TEMP_VIEW, SQLITE_DROP_TEMP_VIEW,
      SQLITE_INSERT, SQLITE_UPDATE, SQLITE_DELETE,
      SQLITE_ATTACH, SQLITE_DETACH,
    } = constants;

    setAuthorizer.call(this.db, (actionCode, arg1, arg2) => {
      switch (actionCode) {
        // Table DDL — arg1 = table name
        case SQLITE_CREATE_TABLE:
        case SQLITE_DROP_TABLE:
        case SQLITE_CREATE_TEMP_TABLE:
        case SQLITE_DROP_TEMP_TABLE:
          this.prepareSawDdl = true;
          return isProtectedSchemaName(arg1) ? SQLITE_DENY : SQLITE_OK;

        // ALTER TABLE — arg1 = db name, arg2 = table name (the new name in
        // RENAME TO is not visible here; the post-DDL schema scan catches it)
        case SQLITE_ALTER_TABLE:
          this.prepareSawDdl = true;
          return isProtectedSchemaName(arg2) ? SQLITE_DENY : SQLITE_OK;

        // Index/trigger DDL — arg1 = object name, arg2 = target table
        case SQLITE_CREATE_INDEX:
        case SQLITE_DROP_INDEX:
        case SQLITE_CREATE_TRIGGER:
        case SQLITE_DROP_TRIGGER:
        case SQLITE_CREATE_TEMP_INDEX:
        case SQLITE_DROP_TEMP_INDEX:
        case SQLITE_CREATE_TEMP_TRIGGER:
        case SQLITE_DROP_TEMP_TRIGGER:
          this.prepareSawDdl = true;
          return isProtectedSchemaName(arg1) || isProtectedSchemaName(arg2) ? SQLITE_DENY : SQLITE_OK;

        // SQLite views share namespace with tables
        case SQLITE_CREATE_VIEW:
        case SQLITE_DROP_VIEW:
        case SQLITE_CREATE_TEMP_VIEW:
        case SQLITE_DROP_TEMP_VIEW:
          this.prepareSawDdl = true;
          return isProtectedSchemaName(arg1) ? SQLITE_DENY : SQLITE_OK;

        // Plugins table is entirely read-only
        case SQLITE_INSERT:
        case SQLITE_UPDATE:
        case SQLITE_DELETE:
          if (arg1 && isUserTableMutationTarget(arg1)) {
            this.prepareMutatedUntrackedTable = true;
          }
          return arg1 === 'plugins' ? SQLITE_DENY : SQLITE_OK;

        // Block database attachment
        case SQLITE_ATTACH:
        case SQLITE_DETACH:
          return SQLITE_DENY;

        default:
          return SQLITE_OK;
      }
    });
  }

  getEnabledPlugins(): Array<{ name: string; title: string; description: string; version: string; code: string }> {
    return this.db.prepare(
      'SELECT name, title, description, version, code FROM plugins WHERE enabled = 1'
    ).all() as Array<{ name: string; title: string; description: string; version: string; code: string }>;
  }

  getPlugin(name: string): { name: string; title: string; description: string; version: string; code: string } | undefined {
    const rows = this.db.prepare(
      'SELECT name, title, description, version, code FROM plugins WHERE name = ?'
    ).all(name) as Array<{ name: string; title: string; description: string; version: string; code: string }>;
    return rows[0];
  }

  getPluginInfo(name: string): { name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number } | undefined {
    const rows = this.db.prepare(
      'SELECT name, title, description, version, author, repository, license, enabled FROM plugins WHERE name = ?'
    ).all(name) as Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
    return rows[0];
  }

  listPlugins(): Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }> {
    return this.db.prepare(
      'SELECT name, title, description, version, author, repository, license, enabled FROM plugins ORDER BY name'
    ).all() as Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
  }

  togglePlugin(name: string, enabled: boolean): void {
    this.adminWrite(() => {
      this.db.prepare(
        'UPDATE plugins SET enabled = ? WHERE name = ?'
      ).run(enabled ? 1 : 0, name);    });
  }

  installPlugins(
    plugins: Array<{ name: string; title?: string; description: string; version: string; code: string; author?: string | null; repository?: string | null; license?: string | null }>,
    docs: Array<{ name: string; content: string }>,
    views: Array<{ name: string; title: string; content: string }>,
    config: Array<{ name: string; value: string | null; description: string }>,
  ): void {
    this.adminWrite(() => {
      const upsertPlugin = this.db.prepare(`
        INSERT INTO plugins (name, title, description, version, code, author, repository, license)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            version = excluded.version,
            code = excluded.code,
            author = excluded.author,
            repository = excluded.repository,
            license = excluded.license
      `);
      const upsertDoc = this.db.prepare(`
        INSERT INTO docs (name, content)
          VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET
            content = excluded.content
      `);
      const upsertView = this.db.prepare(`
        INSERT INTO views (name, title, content)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            title = excluded.title,
            content = excluded.content
      `);
      const upsertConfig = this.db.prepare(`
        INSERT INTO config (name, value, description)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description
      `);

      this.db.exec('BEGIN');
      for (const p of plugins) {
        upsertPlugin.run(p.name, p.title ?? '', p.description, p.version, p.code, p.author ?? null, p.repository ?? null, p.license ?? null);
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
        "DELETE FROM modules WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.prepare(
        "DELETE FROM config WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.prepare(
        "DELETE FROM triggers WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.prepare(
        "DELETE FROM tasks WHERE name = ? OR name LIKE ?"
      ).run(`plugin.${name}`, `plugin.${name}.%`);
      this.db.exec('COMMIT');
    });
  }

  private adminWrite(fn: () => void): void {
    this.shieldedWrite(fn, { drain: true });
  }

  /**
   * Execute `fn` with namespace guards + authorizer disabled. With
   * `drain: true` (admin writes from the runtime), committed changes are
   * drained through the change listener afterward. With `drain: false`
   * (mirror writes replicated from a remote daemon), trigger-generated
   * `_changes` rows are discarded — the caller forwards the original
   * remote change to the UI so the mirror doesn't fabricate a duplicate.
   */
  private shieldedWrite(fn: () => void, opts: { drain: boolean }): void {
    if (this.authorizerAvailable) {
      this.db.setAuthorizer(null);
    }
    this.db.exec(DROP_GUARDS_SQL);
    try {
      this.db.exec('DELETE FROM _changes;');
      fn();
      if (!opts.drain) {
        // Trigger-generated changes from the mirror write belong to the
        // daemon's sequence, not the mirror's — discard them.
        this.db.exec('DELETE FROM _changes;');
      }
    } finally {
      for (const sql of ALL_GUARD_SQL) this.db.exec(sql);
      this.installAuthorizer();
    }
    // Drain after guards are restored — if fn() threw, this line is unreachable
    // so listeners only fire for committed writes.
    if (opts.drain) this.drainChanges();
  }

  run(request: SqlExecutionRequest): unknown[] {
    const params = normalizeParams(request.params) as (null | number | bigint | string)[];
    const trackChanges = this.changeListener && isPotentiallyMutatingSql(request.sql);

    if (!this.authorizerAvailable) {
      guardSqlWithoutAuthorizer(request.sql);
      this.prepareMutatedUntrackedTable = sqlTargetsUntrackedTable(request.sql);
    }

    if (trackChanges) {
      this.db.exec('DELETE FROM _changes;');
    }

    this.prepareSawDdl = false;
    if (this.authorizerAvailable) {
      this.prepareMutatedUntrackedTable = false;
    }
    const statement = this.db.prepare(request.sql);

    if (this.prepareSawDdl) {
      const rows = this.runDdlGuarded(() => statement.all(...params));
      if (trackChanges) {
        this.drainChanges({ table: 'sqlite_schema', rowId: 'main', op: 'update' });
      }
      return rows;
    }

    const rows = statement.all(...params);
    if (trackChanges) {
      this.drainChanges(
        { table: SYNTHETIC_DB_TABLE, rowId: 'main', op: 'update' },
        { alwaysEmitFallback: this.prepareMutatedUntrackedTable },
      );
    }
    return normalizeSqlRows(rows);
  }

  // The authorizer can't inspect the new name in `ALTER TABLE ... RENAME TO ...`
  // (arg2 holds the old name) or distinguish RENAME from ADD COLUMN. Run DDL
  // inside a savepoint and post-scan sqlite_master + sqlite_temp_master for
  // any reserved-namespace object the authorizer couldn't see; rollback if so.
  private runDdlGuarded(execute: () => unknown[]): unknown[] {
    if (!this.reservedSchemaScan) {
      this.reservedSchemaScan = this.db.prepare(RESERVED_SCHEMA_SCAN_SQL);
    }
    this.db.exec(`SAVEPOINT ${DDL_SAVEPOINT};`);
    let released = false;
    try {
      const rows = execute();
      const violation = this.reservedSchemaScan.get() as { type: string; name: string } | undefined;
      if (violation) {
        throw new Error(`Reserved namespace: ${violation.type} "${violation.name}" — names equal to or starting with "system" or "plugin" are reserved`);
      }
      this.db.exec(`RELEASE ${DDL_SAVEPOINT};`);
      released = true;
      return normalizeSqlRows(rows);
    } finally {
      if (!released) {
        this.db.exec(`ROLLBACK TO ${DDL_SAVEPOINT}; RELEASE ${DDL_SAVEPOINT};`);
      }
    }
  }

  private drainChanges(
    fallback?: Omit<AgentDbChange, 'version'>,
    opts: { alwaysEmitFallback?: boolean } = {},
  ): void {
    // We always drain the temp table to keep state clean even when no
    // listener is attached (mirrors run without a listener — they emit
    // manually after applying remote changes).
    const changes = this.db.prepare('SELECT table_name, row_id, previous_row_id, op FROM _changes').all();
    if (changes.length > 0) {
      this.db.exec('DELETE FROM _changes;');
    }

    if (!this.changeListener) return;

    if (changes.length === 0 && fallback) {
      this.versionCounter += 1;
      this.changeListener({ ...fallback, version: this.versionCounter });
      return;
    }

    for (const raw of changes) {
      const record = raw as Record<string, unknown>;
      const table = record.table_name as string;
      const rowId = record.row_id as string | number;
      const previousRowId = record.previous_row_id as string | number | null;
      const op = record.op as 'insert' | 'update' | 'delete';
      this.versionCounter += 1;
      const change: AgentDbChange = { table, rowId, op, version: this.versionCounter };
      if (op === 'update' && previousRowId !== null && previousRowId !== rowId) {
        change.previousRowId = previousRowId;
      }
      if (op !== 'delete' && CHANGE_TRACKED_TABLE_SET.has(table)) {
        const row = this.fetchRowByName(table, rowId);
        if (row) change.row = row;
      }
      this.changeListener(change);
    }

    if (fallback && opts.alwaysEmitFallback) {
      this.versionCounter += 1;
      this.changeListener({ ...fallback, version: this.versionCounter });
    }
  }

  private fetchRowByName(table: string, name: string | number): Record<string, unknown> | null {
    let stmt = this.rowFetchStatements.get(table);
    if (!stmt) {
      // Table name comes from the hard-coded CHANGE_TRACKED_TABLES list (via
      // the trigger) so it is safe to interpolate. Belt-and-suspenders: the
      // set check above already restricts it.
      stmt = this.db.prepare(`SELECT * FROM ${table} WHERE name = ?`);
      this.rowFetchStatements.set(table, stmt);
    }
    const row = stmt.get(name as string) as Record<string, unknown> | undefined;
    if (!row) return null;
    return normalizeSqlRows([row])[0] as Record<string, unknown>;
  }

  getCurrentVersion(): number {
    return this.versionCounter;
  }

  /**
   * Apply a change received from a remote source to this mirror DB. Bypasses
   * the namespace/format guard triggers so `system.*` and `plugin.*` rows
   * replicated from the daemon can land on the mirror. Does NOT emit through
   * the local change listener — the caller emits manually to the UI after
   * applying, so remote-origin changes carry their original version.
   */
  applyMirrorChange(change: AgentDbChange): void {
    if (!CHANGE_TRACKED_TABLE_SET.has(change.table)) {
      throw new Error(`applyMirrorChange: untracked table ${change.table}`);
    }
    if (change.op === 'delete') {
      this.shieldedWrite(() => {
        this.db.prepare(`DELETE FROM ${change.table} WHERE name = ?`).run(change.rowId as string);
      }, { drain: false });
      return;
    }

    const row = change.row;
    if (!row) {
      throw new Error(`applyMirrorChange: missing row data for ${change.op} on ${change.table}`);
    }
    const cols = Object.keys(row);
    if (cols.length === 0) {
      throw new Error(`applyMirrorChange: empty row for ${change.op} on ${change.table}`);
    }
    const { sql, values } = buildUpsertByName(change.table, cols, row);
    this.shieldedWrite(() => {
      this.withoutAutoUpdatedAtTrigger(change.table, () => {
        if (
          change.op === 'update'
          && change.previousRowId !== undefined
          && change.previousRowId !== change.rowId
        ) {
          const update = buildUpdateByName(change.table, cols, row);
          const result = this.db.prepare(update.sql).run(...update.values, change.previousRowId as string) as { changes?: number | bigint };
          const changed = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
          if (changed && changed > 0) return;
        }
        this.db.prepare(sql).run(...values);
      });
    }, { drain: false });
  }

  private withoutAutoUpdatedAtTrigger(table: string, fn: () => void): void {
    this.db.exec(`DROP TRIGGER IF EXISTS ${table}_auto_updated_at;`);
    try {
      fn();
    } finally {
      this.db.exec(makeAutoUpdatedAtTriggerSql(table));
    }
  }

  async exportSnapshot(): Promise<Buffer> {
    const tmpPath = path.join(
      os.tmpdir(),
      `agentwfy-agent-db-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      await backup(this.db, tmpPath);
      return fs.readFileSync(tmpPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  }

  /**
   * Stream a consistent copy of the DB to disk and return the version
   * the snapshot reflects. We capture `version` BEFORE invoking backup() —
   * concurrent writes that commit during backup may or may not appear in
   * the snapshot, but they have version > the captured value and will be
   * re-applied incrementally by mirrors. UPSERT semantics in
   * `applyMirrorChange` make replays idempotent.
   */
  async writeSnapshotFile(snapshotPath: string): Promise<AgentDbSnapshotResult> {
    const version = this.versionCounter;
    await backup(this.db, snapshotPath);
    return { version };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}

/** Build an `INSERT … ON CONFLICT(name) DO UPDATE SET …` for a row keyed on
 *  `name`. Tables and columns come from the hard-coded replicated set
 *  (caller has already validated against CHANGE_TRACKED_TABLE_SET), so
 *  string interpolation here is safe. */
function buildUpsertByName(
  table: string,
  cols: string[],
  row: Record<string, unknown>,
): { sql: string; values: (null | number | bigint | string)[] } {
  const placeholders = cols.map(() => '?').join(', ');
  const setClauses = cols
    .filter((c) => c !== 'name')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const conflict = setClauses.length > 0
    ? `ON CONFLICT(name) DO UPDATE SET ${setClauses}`
    : `ON CONFLICT(name) DO NOTHING`;
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ${conflict}`;
  const values = cols.map((c) => row[c] as null | number | bigint | string);
  return { sql, values };
}

function buildUpdateByName(
  table: string,
  cols: string[],
  row: Record<string, unknown>,
): { sql: string; values: (null | number | bigint | string)[] } {
  const setClauses = cols.map((c) => `${c} = ?`).join(', ');
  const sql = `UPDATE ${table} SET ${setClauses} WHERE name = ?`;
  const values = cols.map((c) => row[c] as null | number | bigint | string);
  return { sql, values };
}

// Module-level registry
const connections = new Map<string, AgentDb>();
const connectionOptions = new Map<string, { syncSystemData?: boolean }>();

export function configureAgentDb(dataDir: string, opts: { syncSystemData?: boolean }): void {
  const key = path.resolve(dataDir);
  connectionOptions.set(key, opts);
}

export function getAgentDbPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), '.agentwfy', 'agent.db');
}

export function getOrCreateAgentDb(dataDir: string): AgentDb {
  const key = path.resolve(dataDir);
  let conn = connections.get(key);
  if (conn) return conn;

  const agentDir = path.join(key, '.agentwfy');
  fs.mkdirSync(agentDir, { recursive: true });
  const agentDbPath = getAgentDbPath(key);
  const systemDocsPath = path.join(import.meta.dirname, '..', 'system-docs.json');
  const systemViewsPath = path.join(import.meta.dirname, '..', 'system-views.json');
  const systemConfigPath = path.join(import.meta.dirname, '..', 'system-config.json');
  const opts = connectionOptions.get(key) ?? {};

  conn = new AgentDb({
    dbPath: agentDbPath,
    systemDocsPath,
    systemViewsPath,
    systemConfigPath,
    syncSystemData: opts.syncSystemData,
  });
  connections.set(key, conn);
  return conn;
}

export function closeAgentDb(dataDir: string): void {
  const key = path.resolve(dataDir);
  const conn = connections.get(key);
  if (conn) {
    conn.close();
    connections.delete(key);
  }
}

export async function exportAgentDbSnapshot(dataDir: string): Promise<Buffer> {
  return getOrCreateAgentDb(dataDir).exportSnapshot();
}

export async function writeAgentDbSnapshotFile(
  dataDir: string,
  snapshotPath: string,
): Promise<AgentDbSnapshotResult> {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.rmSync(snapshotPath, { force: true });
  return getOrCreateAgentDb(dataDir).writeSnapshotFile(snapshotPath);
}

export function getAgentDbCurrentVersion(dataDir: string): number {
  return getOrCreateAgentDb(dataDir).getCurrentVersion();
}

export function applyAgentDbMirrorChange(dataDir: string, change: AgentDbChange): void {
  getOrCreateAgentDb(dataDir).applyMirrorChange(change);
}

export function replaceAgentDbSnapshot(dataDir: string, snapshot: Uint8Array): void {
  const key = path.resolve(dataDir);
  closeAgentDb(key);
  const agentDbPath = getAgentDbPath(key);
  fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
  const tmpPath = `${agentDbPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, snapshot);
  fs.renameSync(tmpPath, agentDbPath);
  fs.rmSync(`${agentDbPath}-wal`, { force: true });
  fs.rmSync(`${agentDbPath}-shm`, { force: true });
}

export function replaceAgentDbSnapshotFile(dataDir: string, snapshotPath: string): void {
  const key = path.resolve(dataDir);
  closeAgentDb(key);
  const agentDbPath = getAgentDbPath(key);
  fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
  const tmpPath = `${agentDbPath}.${process.pid}.${Date.now()}.tmp`;
  fs.renameSync(snapshotPath, tmpPath);
  fs.renameSync(tmpPath, agentDbPath);
  fs.rmSync(`${agentDbPath}-wal`, { force: true });
  fs.rmSync(`${agentDbPath}-shm`, { force: true });
}
