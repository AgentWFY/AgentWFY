import { ipcMain } from 'electron';
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js';
import type { OnDbChange } from '../db/sqlite.js';
import { Channels } from './channels.js';

export function registerSqlHandlers(getRoot: () => string, onDbChange?: OnDbChange) {
  // runSql({ target, path?, sql, params?, description? }) → query result
  ipcMain.handle(Channels.sql.run, async (_event, payload: unknown) => {
    const request = parseRunSqlRequest(payload);
    return routeSqlRequest(getRoot(), request, onDbChange);
  });
}
