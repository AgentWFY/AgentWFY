import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed } from '../security/path-policy.js';
import { Channels } from '../ipc/channels.js';
import type { TaskRunner, TaskOrigin } from './task_runner.js';

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

export function registerTaskRunnerHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getTaskRunner: (e: IpcMainInvokeEvent) => TaskRunner,
): void {
  const resolvePrivatePath = (event: IpcMainInvokeEvent, relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(event), relativePath, { ...options, allowAgentPrivate: true });
  const ensureTaskLogsDir = async (event: IpcMainInvokeEvent): Promise<string> => {
    const taskLogsDir = await resolvePrivatePath(event, '.agentwfy/task_logs', { allowMissing: true });
    await fs.mkdir(taskLogsDir, { recursive: true });
    return taskLogsDir;
  };
  const resolveTaskLogPath = (event: IpcMainInvokeEvent, logFileName: string, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(event, `.agentwfy/task_logs/${normalizeTaskLogFileName(logFileName)}`, options);

  // --- Direct task execution handlers ---

  ipcMain.handle(Channels.tasks.start, async (event, taskId: number, input?: unknown, origin?: TaskOrigin) => {
    const runner = getTaskRunner(event);
    const effectiveOrigin = origin ?? { type: 'view' as const };
    const runId = await runner.startTask(taskId, input, effectiveOrigin);
    return { runId };
  });

  ipcMain.handle(Channels.tasks.stop, async (event, runId: string) => {
    const runner = getTaskRunner(event);
    runner.stopTask(runId);
  });

  ipcMain.handle(Channels.tasks.listRunning, async (event) => {
    const runner = getTaskRunner(event);
    return runner.listRunning();
  });

  // --- Log persistence handlers ---

  // listLogHistory — inlined from TaskRunner class
  ipcMain.handle(Channels.tasks.listLogHistory, async (event) => {
    const dataDir = getRoot(event);
    const taskLogsDir = path.join(dataDir, '.agentwfy', 'task_logs');

    try {
      await fs.mkdir(taskLogsDir, { recursive: true });
    } catch {
      return [];
    }

    try {
      const entries = await fs.readdir(taskLogsDir, { withFileTypes: true });
      const items: Array<{ file: string; updatedAt: number; taskName: string; status: string; origin?: unknown }> = [];

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!TASK_LOG_FILE_NAME_RE.test(entry.name)) continue;

        try {
          const filePath = path.join(taskLogsDir, entry.name);
          const raw = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(raw);
          const stats = await fs.stat(filePath);
          items.push({
            file: entry.name,
            updatedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : Math.floor(stats.mtimeMs),
            taskName: typeof parsed.taskName === 'string' ? parsed.taskName : 'Unknown',
            status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
            origin: parsed.origin ?? undefined,
          });
        } catch {
          // Skip unparseable files
        }
      }

      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return items.slice(0, 50);
    } catch {
      return [];
    }
  });

  // listTaskLogs(limit?) → [{ name, updatedAt }]
  ipcMain.handle(Channels.tasks.listLogs, async (event, limit?: number) => {
    const taskLogsDir = await ensureTaskLogsDir(event);
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
  ipcMain.handle(Channels.tasks.readLog, async (event, logFileName: string) => {
    const logPath = await resolveTaskLogPath(event, logFileName);
    return fs.readFile(logPath, 'utf-8');
  });

  // writeTaskLog(logFileName, content)
  ipcMain.handle(Channels.tasks.writeLog, async (event, logFileName: string, content: string) => {
    const logPath = await resolveTaskLogPath(event, logFileName, { allowMissing: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, content, 'utf-8');
  });
}
