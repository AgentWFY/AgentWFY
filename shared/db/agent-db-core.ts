// Host-neutral AgentDb core. The `AgentDb` class wires the agent schema,
// change-tracking, and namespace/format guards onto an injected `SqlDriver`,
// and bootstraps system docs/views/config from already-parsed data. It has no
// Node imports (no `fs`, no `node:sqlite`), so an alternate backend can build
// the same `AgentDb` over a different `SqlDriver` that the Node daemon and
// desktop build over `NodeSqlDriver`. The Node connection registry, system-JSON
// reading, and snapshot-file I/O live in `agent-db.ts`.

import { isPotentiallyMutatingSql } from './sql-introspect.js';
import { normalizeSqlRows, normalizeParams } from './sql-types.js';
import type { SqlExecutionRequest, AgentDbChange } from './sql-types.js';
import type { SqlDriver, SqlGuard, SqlParam } from './sql-driver.js';

// Agent-issued SQL may not run DDL or write to the plugins table; admin and
// mirror writes lift this via setGuard(null).
const AGENT_SQL_GUARD: SqlGuard = { denyDdl: true, readonlyTables: ['plugins'] };

/** Parsed system docs/views/config used to bootstrap a fresh agent DB. The
 *  Node registry reads these from the bundled JSON files. `null` disables the
 *  sync entirely (remote mirrors). */
export interface SystemData {
  docs: Array<{ name: string; content: string }>;
  views: Array<{ name: string; title: string; content: string }>;
  config: Array<{ name: string; description: string }>;
}

export interface AgentDbSnapshotResult {
  /** Version counter at the moment the snapshot read started — every change
   *  with `version <= snapshotVersion` is in the snapshot, every change with
   *  `version > snapshotVersion` is not. */
  version: number;
}

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

const CHANGE_TRACKED_TABLES = ['views', 'docs', 'tasks', 'triggers', 'config', 'plugins', 'modules'] as const;
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

// Change-tracking table + triggers. These are TEMP, so they stay out of the
// binary `.sqlite` snapshot the desktop mirror downloads (`_changes` and these
// triggers are never replicated).
function makeChangeTrackingSql(): string {
  return `
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
}

// Block agent from writing to system.* and plugin.* rows. These are TEMP so they
// don't interfere with our own upserts on next launch.
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

// Block agent from inserting/deleting system.* and plugin.* config, but allow UPDATE
function makeSystemConfigGuardSql(): string {
  return `
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
}

// Build the full guard SQL set. The triggers are TEMP (kept out of the binary
// snapshot). The DROP set below works regardless.
function makeAllGuardSql(): string[] {
  return [
    ...NAMESPACE_GUARDED_TABLES.map(t => makeNamespaceGuardSql(t)),
    makeSystemConfigGuardSql(),
    ...NAME_FORMAT_TABLES.map(t => makeNameFormatSql(t, '*[^a-z0-9._-]*', `${t.replace(/s$/, '')} name must contain only lowercase letters, digits, dots, hyphens, and underscores`)),
    // Plugin names: no dots (dots are namespace separators in plugin.* prefixes)
    makeNameFormatSql('plugins', '*[^a-z0-9-]*', 'plugin name must contain only lowercase letters, digits, and hyphens'),
  ];
}

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

interface SystemDataSync<T extends { name: string }> {
  items: T[];
  selectSql: string;
  upsertSql: string;
  hasChanged: (item: T, existing: Record<string, unknown>) => boolean;
  bindUpsert: (item: T) => (string | number | null)[];
}

export class AgentDb {
  private sql: SqlDriver;
  private changeListener: ((change: AgentDbChange) => void) | null = null;
  // Monotonic counter for emitted change events. Used by remote mirrors to
  // sequence incremental application and detect gaps. The counter lives in
  // memory only — on process restart it resets, and clients detect this by
  // the WS connection dropping (they fetch a fresh snapshot on reconnect).
  private versionCounter = 0;
  // Change-tracking + guard SQL, built once (the triggers are TEMP).
  private readonly changeTrackingSql: string;
  private readonly allGuardSql: string[];

  constructor(opts: {
    sql: SqlDriver;
    /** Parsed system docs/views/config to bootstrap. `null` skips the sync
     *  entirely (used by remote mirrors that replicate system rows). */
    systemData: SystemData | null;
  }) {
    this.sql = opts.sql;
    this.changeTrackingSql = makeChangeTrackingSql();
    this.allGuardSql = makeAllGuardSql();
    this.init(opts.systemData);
  }

  setChangeListener(listener: (change: AgentDbChange) => void): void {
    this.changeListener = listener;
  }

  /** Generic sync: diff parsed system items against DB, upsert/delete in a transaction. */
  private syncSystemData<T extends { name: string }>(spec: SystemDataSync<T>): void {
    const items = spec.items;

    const rows = this.sql.query(spec.selectSql) as Record<string, unknown>[];
    const existing = new Map(rows.map(r => [r.name as string, r]));

    const toUpsert = items.filter(item => {
      const ex = existing.get(item.name);
      return !ex || spec.hasChanged(item, ex);
    });
    const itemNames = new Set(items.map(i => i.name));
    const toDelete = rows.filter(r => !itemNames.has(r.name as string));

    if (toUpsert.length === 0 && toDelete.length === 0) return;

    const deleteSql = 'DELETE FROM ' + spec.selectSql.match(/FROM (\w+)/i)![1] + ' WHERE name = ?';
    this.sql.transactionSync(() => {
      for (const item of toUpsert) this.sql.run(spec.upsertSql, spec.bindUpsert(item));
      for (const row of toDelete) this.sql.run(deleteSql, [row.name as string]);
    });
  }

  private init(systemData: SystemData | null): void {
    this.sql.execBatch('PRAGMA foreign_keys = ON;');
    this.sql.execBatch(AGENT_DB_SCHEMA_SQL);
    this.sql.execBatch(this.changeTrackingSql);
    for (const sql of this.allGuardSql) this.sql.execBatch(sql);
    this.sql.setGuard(AGENT_SQL_GUARD);

    if (!systemData) return;

    // Seed/refresh the system.* docs/views/config. This writes system.* rows,
    // which the namespace guard triggers (RAISE(ABORT)) would otherwise reject,
    // so it runs through `shieldedWrite` (guards lifted, then restored). This
    // matters most on a persistent-trigger DB, where the guard triggers survive
    // across restarts, so re-seeding changed system rows would abort without
    // this. `drain: false` discards the trigger-generated `_changes` so the seed
    // never fabricates change events — mirrors receive system rows via the
    // snapshot. On Node (TEMP triggers) the outcome is identical to the old
    // "seed before the triggers exist" ordering.
    this.shieldedWrite(() => {
      this.syncSystemData<{ name: string; content: string }>({
        items: systemData.docs,
        selectSql: "SELECT name, content FROM docs WHERE name = 'system' OR name LIKE 'system.%'",
        upsertSql: `INSERT INTO docs (name, content) VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
        hasChanged: (doc, ex) => ex.content !== doc.content,
        bindUpsert: (doc) => [doc.name, doc.content],
      });

      this.syncSystemData<{ name: string; title: string; content: string }>({
        items: systemData.views,
        selectSql: "SELECT name, title, content FROM views WHERE name LIKE 'system.%'",
        upsertSql: `INSERT INTO views (name, title, content) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET title = excluded.title, content = excluded.content`,
        hasChanged: (v, ex) => ex.title !== v.title || ex.content !== v.content,
        bindUpsert: (v) => [v.name, v.title, v.content],
      });

      this.syncSystemData<{ name: string; description: string }>({
        items: systemData.config,
        selectSql: "SELECT name, description FROM config WHERE name LIKE 'system.%'",
        upsertSql: `INSERT INTO config (name, value, description) VALUES (?, NULL, ?)
          ON CONFLICT(name) DO UPDATE SET description = excluded.description`,
        hasChanged: (item, ex) => ex.description !== item.description,
        bindUpsert: (item) => [item.name, item.description],
      });
    }, { drain: false });
  }

  getEnabledPlugins(): Array<{ name: string; title: string; description: string; version: string; code: string }> {
    return this.sql.query(
      'SELECT name, title, description, version, code FROM plugins WHERE enabled = 1'
    ) as Array<{ name: string; title: string; description: string; version: string; code: string }>;
  }

  getPlugin(name: string): { name: string; title: string; description: string; version: string; code: string } | undefined {
    const rows = this.sql.query(
      'SELECT name, title, description, version, code FROM plugins WHERE name = ?', [name]
    ) as Array<{ name: string; title: string; description: string; version: string; code: string }>;
    return rows[0];
  }

  getPluginInfo(name: string): { name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number } | undefined {
    const rows = this.sql.query(
      'SELECT name, title, description, version, author, repository, license, enabled FROM plugins WHERE name = ?', [name]
    ) as Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
    return rows[0];
  }

  listPlugins(): Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }> {
    return this.sql.query(
      'SELECT name, title, description, version, author, repository, license, enabled FROM plugins ORDER BY name'
    ) as Array<{ name: string; title: string; description: string; version: string; author: string | null; repository: string | null; license: string | null; enabled: number }>;
  }

  togglePlugin(name: string, enabled: boolean): void {
    this.adminWrite(() => {
      this.sql.run('UPDATE plugins SET enabled = ? WHERE name = ?', [enabled ? 1 : 0, name]);
    });
  }

  installPlugins(
    plugins: Array<{ name: string; title?: string; description: string; version: string; code: string; author?: string | null; repository?: string | null; license?: string | null }>,
    docs: Array<{ name: string; content: string }>,
    views: Array<{ name: string; title: string; content: string }>,
    config: Array<{ name: string; value: string | null; description: string }>,
  ): void {
    const upsertPluginSql = `
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
      `;
    const upsertDocSql = `
        INSERT INTO docs (name, content)
          VALUES (?, ?)
          ON CONFLICT(name) DO UPDATE SET
            content = excluded.content
      `;
    const upsertViewSql = `
        INSERT INTO views (name, title, content)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            title = excluded.title,
            content = excluded.content
      `;
    const upsertConfigSql = `
        INSERT INTO config (name, value, description)
          VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description
      `;

    this.adminWrite(() => {
      this.sql.transactionSync(() => {
        for (const p of plugins) {
          this.sql.run(upsertPluginSql, [p.name, p.title ?? '', p.description, p.version, p.code, p.author ?? null, p.repository ?? null, p.license ?? null]);
        }
        for (const d of docs) {
          this.sql.run(upsertDocSql, [d.name, d.content]);
        }
        for (const v of views) {
          this.sql.run(upsertViewSql, [v.name, v.title, v.content]);
        }
        for (const c of config) {
          this.sql.run(upsertConfigSql, [c.name, c.value, c.description]);
        }
      });
    });
  }

  uninstallPlugin(name: string): void {
    this.adminWrite(() => {
      this.sql.transactionSync(() => {
        const prefixArgs: SqlParam[] = [`plugin.${name}`, `plugin.${name}.%`];
        this.sql.run('DELETE FROM plugins WHERE name = ?', [name]);
        this.sql.run("DELETE FROM docs WHERE name = ? OR name LIKE ?", prefixArgs);
        this.sql.run("DELETE FROM views WHERE name = ? OR name LIKE ?", prefixArgs);
        this.sql.run("DELETE FROM modules WHERE name = ? OR name LIKE ?", prefixArgs);
        this.sql.run("DELETE FROM config WHERE name = ? OR name LIKE ?", prefixArgs);
        this.sql.run("DELETE FROM triggers WHERE name = ? OR name LIKE ?", prefixArgs);
        this.sql.run("DELETE FROM tasks WHERE name = ? OR name LIKE ?", prefixArgs);
      });
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
    this.sql.setGuard(null);
    this.sql.execBatch(DROP_GUARDS_SQL);
    try {
      this.sql.execBatch('DELETE FROM _changes;');
      fn();
      if (!opts.drain) {
        // Trigger-generated changes from the mirror write belong to the
        // daemon's sequence, not the mirror's — discard them.
        this.sql.execBatch('DELETE FROM _changes;');
      }
    } finally {
      for (const sql of this.allGuardSql) this.sql.execBatch(sql);
      this.sql.setGuard(AGENT_SQL_GUARD);
    }
    // Drain after guards are restored — if fn() threw, this line is unreachable
    // so listeners only fire for committed writes.
    if (opts.drain) this.drainChanges();
  }

  run(request: SqlExecutionRequest): unknown[] {
    const params = normalizeParams(request.params) as SqlParam[];
    const trackChanges = this.changeListener && isPotentiallyMutatingSql(request.sql);

    if (trackChanges) {
      this.sql.execBatch('DELETE FROM _changes;');
    }

    const rows = this.sql.query(request.sql, params);
    if (trackChanges) {
      this.drainChanges();
    }
    return normalizeSqlRows(rows);
  }

  private drainChanges(): void {
    // We always drain the temp table to keep state clean even when no
    // listener is attached (mirrors run without a listener — they emit
    // manually after applying remote changes).
    const changes = this.sql.query('SELECT table_name, row_id, previous_row_id, op FROM _changes');
    if (changes.length > 0) {
      this.sql.execBatch('DELETE FROM _changes;');
    }

    if (!this.changeListener) return;

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
      if (op !== 'delete') {
        const row = this.fetchRowByName(table, rowId);
        if (row) change.row = row;
      }
      this.changeListener(change);
    }
  }

  private fetchRowByName(table: string, name: string | number): Record<string, unknown> | null {
    // Table name comes from the hard-coded CHANGE_TRACKED_TABLES list (via the
    // trigger) so it is safe to interpolate. The driver caches the prepared
    // statement by SQL text, so the per-table query is compiled once.
    const rows = this.sql.query(`SELECT * FROM ${table} WHERE name = ?`, [name as string]);
    const row = rows[0];
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
        this.sql.run(`DELETE FROM ${change.table} WHERE name = ?`, [change.rowId as string]);
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
          const result = this.sql.run(update.sql, [...update.values, change.previousRowId as string]);
          if (result.changes > 0) return;
        }
        this.sql.run(sql, values);
      });
    }, { drain: false });
  }

  private withoutAutoUpdatedAtTrigger(table: string, fn: () => void): void {
    this.sql.execBatch(`DROP TRIGGER IF EXISTS ${table}_auto_updated_at;`);
    try {
      fn();
    } finally {
      this.sql.execBatch(makeAutoUpdatedAtTriggerSql(table));
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
    await this.sql.backupToFile(snapshotPath);
    return { version };
  }

  close(): void {
    this.sql.close();
  }
}

/** Build an `AgentDb` over an injected `SqlDriver`. Host-neutral entry point:
 *  the Node registry passes a `NodeSqlDriver`. `systemData` is `null` for
 *  remote mirrors. */
export function createAgentDb(opts: {
  sql: SqlDriver;
  systemData: SystemData | null;
}): AgentDb {
  return new AgentDb({
    sql: opts.sql,
    systemData: opts.systemData,
  });
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
