// Node-only: run a SQL request against an arbitrary on-disk `.sqlite` file
// (the `sqlite-file` runSql target). This is the one SQL path that opens a
// driver by filesystem path, so it stays out of the node-free `sqlite.ts`.
// Importing this module installs the `sqlite-file` handler into the node-free
// `sql-router.ts` as a side effect (a host that never imports it simply leaves
// that target unsupported).

import { NodeSqlDriver } from './node-sql-driver.js';
import type { SqlParam } from './sql-driver.js';
import { normalizeSqlRows, normalizeParams } from './sql-types.js';
import type { SqlExecutionRequest } from './sql-types.js';
import { resolveSqliteFilePath } from './paths.js';
import { configureSqliteFileSql } from './sql-router.js';

function runSqliteQuery(dbPath: string, request: SqlExecutionRequest): unknown[] {
  const params = normalizeParams(request.params) as SqlParam[];
  const driver = new NodeSqlDriver(dbPath);
  driver.execBatch('PRAGMA foreign_keys = ON;');

  try {
    return normalizeSqlRows(driver.query(request.sql, params));
  } finally {
    driver.close();
  }
}

export async function runSqliteFileSql(sqlitePath: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return runSqliteQuery(sqlitePath, request);
}

configureSqliteFileSql(async (dataDir, request) => {
  const sqlitePath = await resolveSqliteFilePath(dataDir, request.path || '');
  return runSqliteFileSql(sqlitePath, request);
});
