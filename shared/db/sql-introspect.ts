// Static SQL classification helpers. Pure string analysis — no Node imports,
// no SQLite imports. Safe to use from the mobile (browser) bundle.

// Conservative: only known-read prefixes count as non-mutating. Anything else
// (WITH ... INSERT/UPDATE/DELETE, PRAGMA, DDL, BEGIN/COMMIT, ATTACH, VACUUM,
// ...) is treated as potentially mutating. A false negative would split-brain
// the remote mirror against the daemon and drop daemon change-tracking events.
const READ_ONLY_RE = /^(?:SELECT|VALUES|EXPLAIN)\b/i;

export function isPotentiallyMutatingSql(sql: string): boolean {
  return !READ_ONLY_RE.test(stripLeadingSqlComments(sql));
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
