// Static SQL classification helpers. Pure string analysis — no Node imports,
// no SQLite imports. Safe to use from the mobile (browser) bundle.

import type { SqlGuard } from './sql-driver.js';

// Conservative: only known-read prefixes count as non-mutating. Anything else
// (WITH ... INSERT/UPDATE/DELETE, PRAGMA, DDL, BEGIN/COMMIT, ATTACH, VACUUM,
// ...) is treated as potentially mutating. A false negative would split-brain
// the remote mirror against the daemon and drop daemon change-tracking events.
const READ_ONLY_RE = /^(?:SELECT|VALUES|EXPLAIN)\b/i;

export function isPotentiallyMutatingSql(sql: string): boolean {
  return !READ_ONLY_RE.test(stripLeadingSqlComments(sql));
}

// DDL statement leads, matched against the deny set node:sqlite's authorizer
// uses (CREATE/DROP/ALTER of table/index/trigger/view/vtable + ATTACH/DETACH).
// VACUUM/REINDEX/ANALYZE/PRAGMA are intentionally allowed for parity — those
// have their own action codes that the Node guard does not deny.
const DDL_LEADING_RE = /^(?:CREATE|DROP|ALTER|ATTACH|DETACH)\b/i;

/**
 * Software enforcement of a `SqlGuard` by static analysis, for hosts without a
 * settable SQLite authorizer (the Cloudflare DO). Returns a human-readable
 * reason if `sql` violates the guard, or `null` if it is allowed. Node uses
 * node:sqlite's authorizer instead (see node-sql-driver.ts); this is the
 * DO-side equivalent.
 *
 * Unlike node:sqlite's `prepare()` (which compiles only the first statement),
 * the DO's `sql.exec()` runs *every* statement in a multi-statement string, so
 * this scans the whole string — DDL is checked per `;`-delimited statement,
 * read-only-table writes are matched anywhere (to also catch CTE-prefixed
 * writes like `WITH … INSERT INTO plugins …`).
 *
 * Conservative by design (mirrors `isPotentiallyMutatingSql`): string literals
 * and comments are stripped first so their contents can't trip the scan, and
 * table matching tolerates quoting/bracketing and an optional schema prefix.
 */
export function findSqlGuardViolation(sql: string, guard: SqlGuard): string | null {
  const stripped = stripStringsAndComments(sql);
  if (guard.denyDdl) {
    for (const statement of stripped.split(';')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0 && DDL_LEADING_RE.test(trimmed)) {
        return 'DDL (CREATE/DROP/ALTER/ATTACH/DETACH) is not permitted';
      }
    }
  }
  for (const table of guard.readonlyTables) {
    if (writesToTable(stripped, table)) {
      return `table '${table}' is read-only`;
    }
  }
  return null;
}

function writesToTable(strippedSql: string, table: string): boolean {
  const esc = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Optional schema prefix (main.) + optional quote/bracket/backtick around the
  // table name; a trailing identifier-char lookahead so `plugins` doesn't match
  // `plugins_backup`.
  const target = `(?:[A-Za-z_]\\w*\\s*\\.\\s*)?["'\\[\`]?${esc}["'\\]\`]?(?![A-Za-z0-9_])`;
  const insertOrDelete = new RegExp(
    `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|DELETE\\s+FROM)\\s+${target}`,
    'i',
  );
  const update = new RegExp(`\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${target}`, 'i');
  return insertOrDelete.test(strippedSql) || update.test(strippedSql);
}

/** Remove `--`/`/* * /` comments and single-quoted string literals so a keyword
 *  or table scan can't be fooled by their contents. Double-quoted/bracketed
 *  identifiers are kept so a quoted table name still matches. */
function stripStringsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += "''"; // collapse to an empty literal placeholder
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  while (true) {
    const next = rest.trimStart();
    if (next.startsWith('--')) {
      const newline = next.indexOf('\n');
      rest = newline === -1 ? '' : next.slice(newline + 1);
      continue;
    }
    if (next.startsWith('/*')) {
      const end = next.indexOf('*/', 2);
      rest = end === -1 ? '' : next.slice(end + 2);
      continue;
    }
    return next;
  }
}
