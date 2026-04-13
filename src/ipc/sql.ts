import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js';
import { Channels } from './channels.cjs';

export function registerSqlHandlers(getRoot: (e: IpcMainInvokeEvent) => string) {
  ipcMain.handle(Channels.sql.run, async (event, payload: unknown) => {
    const request = parseRunSqlRequest(payload);
    return routeSqlRequest(getRoot(event), request);
  });
}
