// Node-only: run a SQL request against an arbitrary on-disk `.sqlite` file
// (the `sqlite-file` runSql target). This is the one SQL path that opens a
// driver by filesystem path, so it stays out of the node-free `sqlite.ts`.
// Importing this module installs the `sqlite-file` handler into the node-free
// `sql-router.ts` as a side effect (a host that never imports it simply leaves
// that target unsupported).
//
// Path resolution and the security check stay here, on the host: the worker is
// only ever handed a path that already passed `assertPathAllowed`. Execution
// itself happens on a worker thread — these files are user data (candle
// histories with millions of rows), and node:sqlite blocks for the whole query,
// so running one on the Electron main process froze the entire window.

import { runOnSqliteFileWorker } from './sqlite-file-pool.js';
import type { SqlExecutionRequest } from './sql-types.js';
import { resolveSqliteFilePath } from './paths.js';
import { configureSqliteFileSql } from './sql-router.js';

export async function runSqliteFileSql(sqlitePath: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return runOnSqliteFileWorker(sqlitePath, request.sql, request.params);
}

configureSqliteFileSql(async (dataDir, request) => {
  const sqlitePath = await resolveSqliteFilePath(dataDir, request.path || '');
  return runSqliteFileSql(sqlitePath, request);
});
