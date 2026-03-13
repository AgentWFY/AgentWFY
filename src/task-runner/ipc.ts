import { ipcMain, type BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { assertPathAllowed } from '../security/path-policy.js';
import { Channels } from '../ipc/channels.js';

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

// --- Forwarding state for agentview → renderer task operations ---

type PendingTaskRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingStartRequests = new Map<string, PendingTaskRequest>();
const pendingStopRequests = new Map<string, PendingTaskRequest>();

export function forwardStartTask(win: BrowserWindow, taskId: number, input?: unknown): Promise<{ runId: string }> {
  const waiterId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStartRequests.delete(waiterId);
      reject(new Error('startTask forwarding timeout'));
    }, 30_000);
    pendingStartRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer });
    win.webContents.send(Channels.tasks.forwardStart, { waiterId, taskId, input });
  });
}

function forwardStopTask(win: BrowserWindow, runId: string): Promise<void> {
  const waiterId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStopRequests.delete(waiterId);
      reject(new Error('stopTask forwarding timeout'));
    }, 30_000);
    pendingStopRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer });
    win.webContents.send(Channels.tasks.forwardStop, { waiterId, runId });
  });
}

export function registerTaskRunnerHandlers(getRoot: () => string, getMainWindow: () => BrowserWindow | null): void {
  const resolvePrivatePath = (relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(), relativePath, { ...options, allowAgentPrivate: true });
  const ensureTaskLogsDir = async (): Promise<string> => {
    const taskLogsDir = await resolvePrivatePath('.agentwfy/task_logs', { allowMissing: true });
    await fs.mkdir(taskLogsDir, { recursive: true });
    return taskLogsDir;
  };
  const resolveTaskLogPath = (logFileName: string, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(`.agentwfy/task_logs/${normalizeTaskLogFileName(logFileName)}`, options);

  // --- Forwarding handlers for agentview callers ---

  ipcMain.handle(Channels.tasks.start, async (_event, taskId: number, input?: unknown) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Main window is not available');
    return forwardStartTask(win, taskId, input);
  });

  ipcMain.handle(Channels.tasks.stop, async (_event, runId: string) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) throw new Error('Main window is not available');
    return forwardStopTask(win, runId);
  });

  // Renderer resolved a forwarded startTask
  ipcMain.on(Channels.tasks.forwardStartResult, (_event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingStartRequests.get(payload.waiterId);
    if (pending) {
      pendingStartRequests.delete(payload.waiterId);
      clearTimeout(pending.timer);
      const result = payload.result as Record<string, unknown>;
      if (result && typeof result === 'object' && 'error' in result) {
        pending.reject(new Error(result.error as string));
      } else {
        pending.resolve(result);
      }
    }
  });

  // Renderer resolved a forwarded stopTask
  ipcMain.on(Channels.tasks.forwardStopResult, (_event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingStopRequests.get(payload.waiterId);
    if (pending) {
      pendingStopRequests.delete(payload.waiterId);
      clearTimeout(pending.timer);
      const result = payload.result as Record<string, unknown>;
      if (result && typeof result === 'object' && 'error' in result) {
        pending.reject(new Error(result.error as string));
      } else {
        pending.resolve(undefined);
      }
    }
  });

  // --- Log persistence handlers (unchanged) ---

  // listLogHistory — inlined from TaskRunner class
  ipcMain.handle(Channels.tasks.listLogHistory, async () => {
    const dataDir = getRoot();
    const taskLogsDir = path.join(dataDir, '.agentwfy', 'task_logs');

    try {
      await fs.mkdir(taskLogsDir, { recursive: true });
    } catch {
      return [];
    }

    try {
      const entries = await fs.readdir(taskLogsDir, { withFileTypes: true });
      const items: Array<{ file: string; updatedAt: number; taskName: string; status: string }> = [];

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
