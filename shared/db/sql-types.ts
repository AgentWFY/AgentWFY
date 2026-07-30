// Host-neutral SQL value/row types and normalization helpers. Pure data
// shaping — no Node imports, no SQLite imports — so the AgentDb core can share
// them across hosts (the Node daemon, the desktop, and any alternate backend).

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

// Copy-on-write: only bigints actually need normalizing, and a SQLite row is a
// flat bag of primitives, so the overwhelmingly common case is "nothing to do".
// Rebuilding every row regardless was about half the cost of a large SELECT
// (measured: 32 ms of a 67 ms 50k-row scan, all of it on the main thread).
// Returning the input untouched when nothing changed keeps that walk read-only.
function normalizeSqlValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const next = normalizeSqlValue(item);
      if (next === item) continue;
      if (!copy) copy = value.slice();
      copy[i] = next;
    }
    return copy ?? value;
  }

  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Not a plain object, so not something a row nests — a BLOB comes back as a
    // Uint8Array. Pass it through instead of walking it: enumerating a byte
    // array is O(size) and used to rebuild the BLOB as an index-keyed object.
    if (proto !== Object.prototype && proto !== null) return value;

    const obj = value as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(obj)) {
      const item = obj[key];
      const next = normalizeSqlValue(item);
      if (next === item) continue;
      if (!copy) copy = { ...obj };
      copy[key] = next;
    }
    return copy ?? obj;
  }

  return value;
}

export function normalizeSqlRows(rows: unknown[]): unknown[] {
  return normalizeSqlValue(rows) as unknown[];
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
