import { ipcMain } from 'electron';
import { getTaskRunner } from './task-runner';

export function registerTaskRunnerHandlers(): void {
  ipcMain.handle('task:startTask', async (_event, taskId: number) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    const runId = await runner.startTask(taskId);
    return runId;
  });

  ipcMain.handle('task:stopTask', async (_event, runId: string) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    runner.stopTask(runId);
  });

  ipcMain.handle('task:runTask', async (_event, taskId: number) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    return runner.runTask(taskId);
  });

  ipcMain.handle('task:getRuns', async () => {
    const runner = getTaskRunner();
    if (!runner) return [];
    return runner.getSerializedRuns();
  });

  ipcMain.handle('task:listLogHistory', async () => {
    const runner = getTaskRunner();
    if (!runner) return [];
    return runner.listLogHistory();
  });
}
