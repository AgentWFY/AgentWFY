import { DatabaseSync, StatementSync, backup, constants } from 'node:sqlite';
import type { SqlDriver, SqlGuard, SqlParam, SqlRunResult } from './sql-driver.js';

type AuthorizerCallback = Parameters<DatabaseSync['setAuthorizer']>[0];
type MaybeAuthorizerDb = DatabaseSync & {
  setAuthorizer?: (callback: AuthorizerCallback | null) => void;
};

// node:sqlite's bind-value union for prepared-statement params.
type BindValue = null | number | bigint | string | Uint8Array;

export interface NodeSqlDriverOptions {
  readOnly?: boolean;
}

/** Prepared statements kept per connection. Comfortably covers the repeated
 *  queries the caches exist for; the tail is one-off SQL that would never be
 *  reused anyway. */
const MAX_CACHED_STATEMENTS = 128;

/**
 * `SqlDriver` backed by node:sqlite's `DatabaseSync`. Used by the Node daemon
 * and the Electron desktop host.
 */
export class NodeSqlDriver implements SqlDriver {
  private db: DatabaseSync;
  // Cache prepared statements by SQL text. Keeps hot paths — change drains, row
  // fetches, upsert loops — from re-parsing on every call. node:sqlite's
  // authorizer runs at compile
  // time, so the cache is cleared whenever the guard changes (see setGuard) to
  // avoid reusing a statement compiled under a different guard.
  // Insertion-ordered, so the first key is the least recently used.
  private statements = new Map<string, StatementSync>();

  constructor(dbPath: string, opts: NodeSqlDriverOptions = {}) {
    this.db = opts.readOnly
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(dbPath);
  }

  private prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) {
      // Re-insert to mark as most recently used.
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }

    const stmt = this.db.prepare(sql);
    this.statements.set(sql, stmt);

    // Bounded because callers generate one-off SQL: an agent scanning candle
    // history emits a fresh 250-term OR predicate per call, and the connection
    // now outlives the query, so an unbounded map would retain every statement
    // it ever compiled.
    while (this.statements.size > MAX_CACHED_STATEMENTS) {
      const oldest = this.statements.keys().next();
      if (oldest.done) break;
      this.statements.delete(oldest.value);
    }

    return stmt;
  }

  execBatch(sql: string): void {
    this.db.exec(sql);
  }

  query(sql: string, params: SqlParam[] = []): Record<string, unknown>[] {
    return this.prepare(sql).all(...(params as BindValue[])) as Record<string, unknown>[];
  }

  run(sql: string, params: SqlParam[] = []): SqlRunResult {
    const result = this.prepare(sql).run(...(params as BindValue[]));
    const changes = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
    return { changes };
  }

  transactionSync<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back (or never started).
      }
      throw err;
    }
  }

  setGuard(guard: SqlGuard | null): void {
    const setAuthorizer = (this.db as MaybeAuthorizerDb).setAuthorizer;
    // Best-effort: Electron's bundled node:sqlite may predate setAuthorizer.
    if (typeof setAuthorizer !== 'function') return;
    // Statements compiled under the previous guard must not be reused under a
    // new one — the authorizer is a compile-time hook, so a cached statement
    // would skip it. Drop the cache on every guard change.
    this.statements.clear();
    setAuthorizer.call(this.db, guard ? buildAuthorizer(guard) : null);
  }

  async backupToFile(destPath: string): Promise<void> {
    await backup(this.db, destPath);
  }

  close(): void {
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}

function buildAuthorizer(guard: SqlGuard): AuthorizerCallback {
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
    SQLITE_CREATE_VTABLE, SQLITE_DROP_VTABLE,
    SQLITE_INSERT, SQLITE_UPDATE, SQLITE_DELETE,
    SQLITE_ATTACH, SQLITE_DETACH,
  } = constants;

  const ddlActions = new Set<number>([
    SQLITE_CREATE_TABLE, SQLITE_DROP_TABLE, SQLITE_ALTER_TABLE,
    SQLITE_CREATE_INDEX, SQLITE_DROP_INDEX,
    SQLITE_CREATE_TRIGGER, SQLITE_DROP_TRIGGER,
    SQLITE_CREATE_TEMP_TABLE, SQLITE_DROP_TEMP_TABLE,
    SQLITE_CREATE_TEMP_INDEX, SQLITE_DROP_TEMP_INDEX,
    SQLITE_CREATE_TEMP_TRIGGER, SQLITE_DROP_TEMP_TRIGGER,
    SQLITE_CREATE_VIEW, SQLITE_DROP_VIEW,
    SQLITE_CREATE_TEMP_VIEW, SQLITE_DROP_TEMP_VIEW,
    SQLITE_CREATE_VTABLE, SQLITE_DROP_VTABLE,
    SQLITE_ATTACH, SQLITE_DETACH,
  ]);
  const readonly = new Set<string>(guard.readonlyTables);

  return (actionCode, arg1) => {
    if (guard.denyDdl && ddlActions.has(actionCode)) {
      return SQLITE_DENY;
    }
    if (actionCode === SQLITE_INSERT || actionCode === SQLITE_UPDATE || actionCode === SQLITE_DELETE) {
      return readonly.has(arg1 ?? '') ? SQLITE_DENY : SQLITE_OK;
    }
    return SQLITE_OK;
  };
}
