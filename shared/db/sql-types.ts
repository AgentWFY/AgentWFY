// Host-neutral SQL value/row types and normalization helpers. Pure data
// shaping — no Node imports, no SQLite imports — so the AgentDb core and the
// Cloudflare DO host can share them with the Node daemon and desktop.

export interface SqlExecutionRequest {
  sql: string;
  params?: unknown[];
}

export interface AgentDbChange {
  table: string;
  rowId: string | number;
  op: 'insert' | 'update' | 'delete';
  /**
   * Previous primary-key value for update events that changed the replicated
   * row key. Mirrors use it to update the existing row instead of leaving the
   * old key behind.
   */
  previousRowId?: string | number;
  /**
   * Monotonic per-AgentDb version assigned by the daemon when the change is
   * drained. Increments by 1 for every emitted change. Mirrors use this to
   * sequence incremental application and to detect gaps that require a full
   * re-snapshot.
   *
   * Local agents (no remote mirror) just ignore it.
   */
  version: number;
  /**
   * Snapshot of the row at change time, for insert/update events. Absent
   * for deletes. When absent on a non-delete change, mirrors fall back to
   * a full snapshot.
   */
  row?: Record<string, unknown>;
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

export function normalizeSqlRows(rows: unknown[]): unknown[] {
  return rows.map((row) => normalizeSqlValue(row));
}

export function normalizeParams(params: unknown[] | undefined): unknown[] {
  if (typeof params === 'undefined') {
    return [];
  }

  if (!Array.isArray(params)) {
    throw new Error('SQL params must be an array when provided');
  }

  return params;
}
