// Host-neutral SQL driver seam. The agent DB is identical on every host; only
// the underlying SQLite engine differs. `AgentDb` talks to this interface so an
// alternate backend can swap node:sqlite's `DatabaseSync` for a different SQLite
// implementation without touching `agent-db.ts`.
//
// The interface stays to the common subset both kinds of engine offer: a
// prepare/exec surface for statements and an atomic `transactionSync` (rather
// than raw BEGIN/COMMIT, which not every engine exposes). Some engines also
// forbid TEMP objects, so guards/change-tracking can be made persistent.

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

  /** Run `fn` atomically (the Node driver wraps BEGIN/COMMIT, ROLLBACK on throw).
   *  Not nestable. */
  transactionSync<T>(fn: () => T): T;

  /** Install (or clear, with null) the agent guard. Best-effort: hosts without
   *  an enforcement mechanism may no-op. */
  setGuard(guard: SqlGuard | null): void;

  /** Write a consistent copy of the database to `destPath`. */
  backupToFile(destPath: string): Promise<void>;

  close(): void;
}
