import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AgentBackend } from '#shared/backend/interface.js';
import { Channels } from './channels.cjs';

export function registerSqlHandlers(getBackend: (e: IpcMainInvokeEvent) => AgentBackend) {
  ipcMain.handle(Channels.sql.run, async (event, payload: unknown) => {
    return getBackend(event).functions.invoke({ name: 'runSql', params: payload });
  });
}
