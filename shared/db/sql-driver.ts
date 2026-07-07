// Host-neutral SQL driver seam. The agent DB is identical on every host
// (Node daemon, Electron desktop, Cloudflare Durable Object); only the
// underlying SQLite engine differs. `AgentDb` talks to this interface so the
// Cloudflare port can swap node:sqlite's `DatabaseSync` for a DO
// `ctx.storage.sql` implementation without touching `agent-db.ts`.
//
// The shape deliberately mirrors what both engines offer:
//   - node:sqlite -> DatabaseSync.prepare(sql).all/.run, exec(), BEGIN/COMMIT
//   - DO SQLite   -> ctx.storage.sql.exec(sql, ...params), storage.transactionSync
// DO cannot run BEGIN/COMMIT or TEMP objects, so transactions go through
// `transactionSync` and (in Phase 2) guards/change-tracking become persistent.

export type SqlParam = null | number | bigint | string | Uint8Array;

export interface SqlRunResult {
  /** Rows affected by the last INSERT/UPDATE/DELETE. */
  changes: number;
}

/**
 * Restriction applied to agent-issued statements. The Node driver enforces it
 * with node:sqlite's authorizer; other hosts may enforce it differently. Null
 * lifts all restrictions (admin / mirror writes).
 */
export interface SqlGuard {
  /** Deny DDL: CREATE/DROP/ALTER (table/index/trigger/view/vtable), ATTACH/DETACH. */
  denyDdl: boolean;
  /** Tables the agent may not INSERT/UPDATE/DELETE. */
  readonlyTables: readonly string[];
}

export interface SqlDriver {
  /** Run a batch of one or more statements for side effects (DDL / seed). No
   *  bindings; no rows returned. */
  execBatch(sql: string): void;

  /** Run a single statement with positional bindings, returning all rows. */
  query(sql: string, params?: SqlParam[]): Record<string, unknown>[];

  /** Run a single statement with positional bindings for its side effects. */
  run(sql: string, params?: SqlParam[]): SqlRunResult;

  /** Run `fn` atomically. Node wraps BEGIN/COMMIT (ROLLBACK on throw); DO uses
   *  storage.transactionSync. Not nestable. */
  transactionSync<T>(fn: () => T): T;

  /** Install (or clear, with null) the agent guard. Best-effort: hosts without
   *  an enforcement mechanism may no-op. */
  setGuard(guard: SqlGuard | null): void;

  /** Write a consistent copy of the database to `destPath`. */
  backupToFile(destPath: string): Promise<void>;

  close(): void;
}
