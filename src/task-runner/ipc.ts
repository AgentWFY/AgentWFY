import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed } from '../security/path-policy';
import { Channels } from '../ipc/channels';
import { getTaskRunner } from './task-runner';

const DEFAULT_TASK_LOG_LIST_LIMIT = 200;
const MAX_TASK_LOG_LIST_LIMIT = 1000;
const TASK_LOG_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

function normalizeTaskLogFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Task log file name must be a string');
  }
  const normalized = value.trim();
  if (!TASK_LOG_FILE_NAME_RE.test(normalized)) {
    throw new Error('Task log file name must match /^[A-Za-z0-9._-]+\\.json$/');
  }
  return normalized;
}

export function registerTaskRunnerHandlers(getRoot: () => string): void {
  const resolvePrivatePath = (relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(), relativePath, { ...options, allowAgentPrivate: true });
  const ensureTaskLogsDir = async (): Promise<string> => {
    const taskLogsDir = await resolvePrivatePath('.agentwfy/task_logs', { allowMissing: true });
    await fs.mkdir(taskLogsDir, { recursive: true });
    return taskLogsDir;
  };
  const resolveTaskLogPath = (logFileName: string, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(`.agentwfy/task_logs/${normalizeTaskLogFileName(logFileName)}`, options);

  ipcMain.handle(Channels.tasks.start, async (_event, taskId: number) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    const runId = await runner.startTask(taskId);
    return runId;
  });

  ipcMain.handle(Channels.tasks.stop, async (_event, runId: string) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    runner.stopTask(runId);
  });

  ipcMain.handle(Channels.tasks.run, async (_event, taskId: number) => {
    const runner = getTaskRunner();
    if (!runner) throw new Error('TaskRunner not initialized');
    return runner.runTask(taskId);
  });

  ipcMain.handle(Channels.tasks.getRuns, async () => {
    const runner = getTaskRunner();
    if (!runner) return [];
    return runner.getSerializedRuns();
  });

  ipcMain.handle(Channels.tasks.listLogHistory, async () => {
    const runner = getTaskRunner();
    if (!runner) return [];
    return runner.listLogHistory();
  });

  // listTaskLogs(limit?) → [{ name, updatedAt }]
  ipcMain.handle(Channels.tasks.listLogs, async (_event, limit?: number) => {
    const taskLogsDir = await ensureTaskLogsDir();
    const requestedLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : DEFAULT_TASK_LOG_LIST_LIMIT;
    const effectiveLimit = Math.max(1, Math.min(requestedLimit, MAX_TASK_LOG_LIST_LIMIT));

    const entries = await fs.readdir(taskLogsDir, { withFileTypes: true });
    const logs: Array<{ name: string; updatedAt: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!TASK_LOG_FILE_NAME_RE.test(entry.name)) continue;

      const filePath = path.join(taskLogsDir, entry.name);
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        continue;
      }

      logs.push({
        name: entry.name,
        updatedAt: Math.floor(stats.mtimeMs),
      });
    }

    logs.sort((a, b) => b.updatedAt - a.updatedAt);
    return logs.slice(0, effectiveLimit);
  });

  // readTaskLog(logFileName) → file content
  ipcMain.handle(Channels.tasks.readLog, async (_event, logFileName: string) => {
    const logPath = await resolveTaskLogPath(logFileName);
    return fs.readFile(logPath, 'utf-8');
  });

  // writeTaskLog(logFileName, content)
  ipcMain.handle(Channels.tasks.writeLog, async (_event, logFileName: string, content: string) => {
    const logPath = await resolveTaskLogPath(logFileName, { allowMissing: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, content, 'utf-8');
  });
}
