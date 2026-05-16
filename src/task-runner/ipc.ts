import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { Channels } from '../ipc/channels.cjs';
import { listTasks } from '#shared/db/tasks.js';
import { taskActionId } from '../shortcuts/task-actions.js';
import type { ShortcutManager } from '../shortcuts/manager.js';
import type { TaskOrigin } from '#shared/task-runner/task_runner.js';
import type { AgentBackend } from '#shared/backend/interface.js';

export function registerTaskRunnerHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getShortcutManager: (e: IpcMainInvokeEvent) => ShortcutManager,
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
): void {
  ipcMain.handle(Channels.tasks.start, async (event, taskName: string, input?: unknown, origin?: TaskOrigin) => {
    const backend = getBackend(event);
    const effectiveOrigin = origin ?? { type: 'view' as const };
    return backend.tasks.start({ taskName, input, origin: effectiveOrigin });
  });

  ipcMain.handle(Channels.tasks.stop, async (event, runId: string) => {
    await getBackend(event).tasks.stop({ runId });
  });

  ipcMain.handle(Channels.tasks.listRunning, async (event) => {
    return getBackend(event).tasks.listRunning();
  });

  ipcMain.handle(Channels.tasks.listShortcuts, async (event) => {
    if (getBackend(event).kind !== 'local') return {};
    const sm = getShortcutManager(event);
    const tasks = await listTasks(getRoot(event));
    const out: Record<string, string> = {};
    for (const t of tasks) {
      const display = sm.getDisplayShortcut(taskActionId(t.name));
      if (display) out[t.name] = display;
    }
    return out;
  });

  ipcMain.handle(Channels.tasks.listLogHistory, async (event) => {
    return getBackend(event).tasks.listLogHistory();
  });

  ipcMain.handle(Channels.tasks.readLog, async (event, logFileName: string) => {
    return getBackend(event).tasks.readLog({ logFileName });
  });
}
