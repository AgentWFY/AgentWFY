import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js';
import type { OnDbChange } from '../db/sqlite.js';
import { Channels } from './channels.cjs';

export function registerSqlHandlers(getRoot: (e: IpcMainInvokeEvent) => string, onDbChange?: (event: IpcMainInvokeEvent, change: Parameters<OnDbChange>[0]) => void) {
  // runSql({ target, path?, sql, params?, description? }) → query result
  ipcMain.handle(Channels.sql.run, async (event, payload: unknown) => {
    const request = parseRunSqlRequest(payload);
    const wrappedOnDbChange: OnDbChange | undefined = onDbChange
      ? (change) => onDbChange(event, change)
      : undefined;
    return routeSqlRequest(getRoot(event), request, wrappedOnDbChange);
  });
}
