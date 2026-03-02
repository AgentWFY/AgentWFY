import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import type { BrowserWindow } from 'electron';
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router';
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy';
import type { OnDbChange } from '../db/sqlite';
import { JsRuntime, type TaskHostServices } from './js-runtime';
import type { TaskRun, TaskLogHistoryItem } from './types';

const TASK_LOG_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

function createRunId(taskId: number): string {
  return `task-${taskId}-${crypto.randomUUID()}`;
}

function createLogFileName(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}.json`;
}

export interface TaskRunnerDeps {
  getDataDir: () => string
  getMainWindow: () => BrowserWindow | null
  tabTools: {
    getTabs: () => Promise<{ tabs: Array<Record<string, unknown>> }>
    openTab: (req: { viewId?: string | number; filePath?: string; url?: string; title?: string }) => Promise<void>
    closeTab: (req: { tabId: string }) => Promise<void>
    selectTab: (req: { tabId: string }) => Promise<void>
    reloadTab: (req: { tabId: string }) => Promise<void>
    captureTab: (req: { tabId: string }) => Promise<{ base64: string; mimeType: 'image/png' }>
    getTabConsoleLogs: (req: { tabId: string; since?: number; limit?: number }) => Promise<Array<{ level: string; message: string; timestamp: number }>>
    execTabJs: (req: { tabId: string; code: string; timeoutMs?: number }) => Promise<unknown>
  }
  onDbChange?: OnDbChange
  forwardBusPublish: (win: BrowserWindow, topic: string, data: unknown) => void
  forwardBusWaitFor: (win: BrowserWindow, topic: string, timeoutMs?: number) => Promise<unknown>
  forwardSpawnAgent: (win: BrowserWindow, prompt: string) => Promise<{ agentId: string }>
}

// File operation constants (same as agent-tools.ts)
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

function truncateText(text: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean; totalLines: number; shownLines: number } {
  const lines = text.split('\n');
  const totalLines = lines.length;

  let byteCount = 0;
  let lineCount = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (byteCount + lineBytes > maxBytes && i > 0) break;
    byteCount += lineBytes;
    lineCount++;
  }

  if (lineCount >= totalLines) {
    return { content: text, truncated: false, totalLines, shownLines: totalLines };
  }

  return {
    content: lines.slice(0, lineCount).join('\n'),
    truncated: true,
    totalLines,
    shownLines: lineCount,
  };
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen) + '…';
}

async function walkDir(dir: string, root: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isAgentPrivatePath(root, full)) continue;
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      results.push(rel + '/');
      results.push(...await walkDir(full, root));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function matchesGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(filename);
}

export class TaskRunner {
  private _runs: TaskRun[] = [];
  private runtime: JsRuntime;
  private deps: TaskRunnerDeps;
  private completionWaiters = new Map<string, { resolve: (value: unknown) => void }>();

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
    this.runtime = new JsRuntime(this.buildHostServices());
  }

  get runs(): TaskRun[] {
    return this._runs;
  }

  get runningCount(): number {
    return this._runs.filter(r => r.status === 'running').length;
  }

  get runningLabels(): string[] {
    return this._runs.filter(r => r.status === 'running').map(r => r.name);
  }

  async startTask(taskId: number): Promise<string> {
    const dataDir = this.deps.getDataDir();
    const rows = await routeSqlRequest(dataDir, {
      target: 'agent',
      sql: 'SELECT id, name, content, timeout_ms FROM tasks WHERE id = ? LIMIT 1',
      params: [taskId],
    }, this.deps.onDbChange) as Array<{ id: number; name: string; content: string; timeout_ms: number | null }>;

    if (!rows || rows.length === 0) {
      throw new Error(`Task ${taskId} not found`);
    }

    const task = rows[0];
    const runId = createRunId(taskId);
    const timeoutMs = typeof task.timeout_ms === 'number' && task.timeout_ms > 0
      ? task.timeout_ms
      : 0;

    const run: TaskRun = {
      runId,
      taskId,
      name: task.name,
      status: 'running',
      startedAt: Date.now(),
      logs: [],
    };

    this._runs.unshift(run);
    this.notifyRenderer();

    this.runtime.ensureWorker(runId);

    void this.executeRun(run, task.content, timeoutMs);

    return runId;
  }

  async runTask(taskId: number): Promise<string> {
    const runId = await this.startTask(taskId);
    await new Promise<unknown>((resolve) => {
      this.completionWaiters.set(runId, { resolve });
    });
    return runId;
  }

  stopTask(runId: string): void {
    const run = this._runs.find(r => r.runId === runId);
    if (!run || run.status !== 'running') return;

    this.runtime.terminateWorker(runId);

    run.status = 'failed';
    run.error = 'Stopped by user';
    run.finishedAt = Date.now();
    this.notifyRenderer();
    void this.persistLog(run);
  }

  async listLogHistory(): Promise<TaskLogHistoryItem[]> {
    const dataDir = this.deps.getDataDir();
    const taskLogsDir = path.join(dataDir, '.agentwfy', 'task_logs');

    try {
      await fs.mkdir(taskLogsDir, { recursive: true });
    } catch {
      return [];
    }

    try {
      const entries = await fs.readdir(taskLogsDir, { withFileTypes: true });
      const items: TaskLogHistoryItem[] = [];

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
  }

  getSerializedRuns(): TaskRun[] {
    return this._runs;
  }

  disposeAll(): void {
    this.runtime.disposeAll();
    this._runs = [];
    this.completionWaiters.clear();
  }

  private async executeRun(run: TaskRun, code: string, timeoutMs: number): Promise<void> {
    try {
      const details = await this.runtime.executeExecJs(run.runId, code, timeoutMs);

      run.logs = details.logs ?? [];

      if (details.ok) {
        run.status = 'completed';
        run.result = details.value;
      } else {
        run.status = 'failed';
        run.error = details.error?.message ?? 'Unknown error';
      }
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      this.runtime.terminateWorker(run.runId);
      this.notifyRenderer();
      void this.persistLog(run);

      // Publish to renderer bus so worker code that calls waitFor('task:run:...') still works
      const win = this.deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        this.deps.forwardBusPublish(win, `task:run:${run.runId}`, {
          runId: run.runId, taskId: run.taskId, name: run.name,
          status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
          result: run.result, error: run.error, logs: run.logs,
        });
      }

      // Resolve internal completion waiters
      const waiter = this.completionWaiters.get(run.runId);
      if (waiter) {
        this.completionWaiters.delete(run.runId);
        waiter.resolve(undefined);
      }
    }
  }

  private notifyRenderer(): void {
    const win = this.deps.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('task:state-changed', this._runs);
    }
  }

  private async persistLog(run: TaskRun): Promise<void> {
    try {
      const dataDir = this.deps.getDataDir();
      const taskLogsDir = path.join(dataDir, '.agentwfy', 'task_logs');
      await fs.mkdir(taskLogsDir, { recursive: true });

      const logFileName = createLogFileName();
      const logData = {
        taskId: run.taskId,
        taskName: run.name,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result ?? null,
        error: run.error ?? null,
        logs: run.logs,
      };

      await fs.writeFile(path.join(taskLogsDir, logFileName), JSON.stringify(logData, null, 2), 'utf-8');
      run.logFile = logFileName;
    } catch (err) {
      console.error('[TaskRunner] failed to persist log', err);
    }
  }

  private buildHostServices(): TaskHostServices {
    const deps = this.deps;
    const resolveToolPath = (relativePath: string, options?: { allowMissing?: boolean; allowAgentPrivate?: boolean }) =>
      assertPathAllowed(deps.getDataDir(), relativePath, options);
    const resolveToolRoot = () =>
      assertPathAllowed(deps.getDataDir(), '.', { allowMissing: true, allowAgentPrivate: true });

    return {
      async runSql(request) {
        const parsed = parseRunSqlRequest({
          target: request.target ?? 'agent',
          path: request.path,
          sql: request.sql,
          params: request.params,
          description: request.description,
        });
        return routeSqlRequest(deps.getDataDir(), parsed, deps.onDbChange);
      },

      async read(relativePath, offset, limit) {
        const filePath = await resolveToolPath(relativePath);
        const raw = await fs.readFile(filePath, 'utf-8');
        const allLines = raw.split('\n');
        const totalLines = allLines.length;

        const startLine = offset ? Math.max(0, offset - 1) : 0;
        if (startLine >= totalLines) {
          throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
        }

        const effectiveLimit = limit ?? MAX_READ_LINES;
        const endLine = Math.min(startLine + effectiveLimit, totalLines);
        const selected = allLines.slice(startLine, endLine).join('\n');

        const trunc = truncateText(selected, effectiveLimit, MAX_READ_BYTES);
        const actualEnd = startLine + trunc.shownLines;

        let output = trunc.content;

        if (trunc.truncated || actualEnd < totalLines) {
          const nextOffset = actualEnd + 1;
          output += `\n\n[Showing lines ${startLine + 1}-${actualEnd} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
        }

        return output;
      },

      async write(relativePath, content) {
        const filePath = await resolveToolPath(relativePath, { allowMissing: true });
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${relativePath}`;
      },

      async edit(relativePath, oldText, newText) {
        const filePath = await resolveToolPath(relativePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const occurrences = content.split(oldText).length - 1;
        if (occurrences === 0) {
          throw new Error(`Could not find the exact text in ${relativePath}. The old text must match exactly including all whitespace and newlines.`);
        }
        if (occurrences > 1) {
          throw new Error(`Found ${occurrences} occurrences of the text in ${relativePath}. The text must be unique. Provide more context to make it unique.`);
        }
        const updated = content.replace(oldText, newText);
        await fs.writeFile(filePath, updated, 'utf-8');
        return `Successfully replaced text in ${relativePath}`;
      },

      async ls(relativePath, limit) {
        const root = await resolveToolRoot();
        const dirPath = await resolveToolPath(relativePath || '.');
        const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;

        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

        const results: string[] = [];
        let limitReached = false;

        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry.name);
          if (isAgentPrivatePath(root, entryPath)) continue;
          if (results.length >= effectiveLimit) {
            limitReached = true;
            break;
          }
          results.push(entry.isDirectory() ? entry.name + '/' : entry.name);
        }

        if (results.length === 0) return '(empty directory)';

        let output = results.join('\n');
        if (limitReached) {
          output += `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more.]`;
        }
        return output;
      },

      async mkdir(relativePath, recursive) {
        const dirPath = await resolveToolPath(relativePath, { allowMissing: true });
        await fs.mkdir(dirPath, { recursive: recursive ?? true });
      },

      async remove(relativePath, recursive) {
        const targetPath = await resolveToolPath(relativePath, { allowMissing: true });
        await fs.rm(targetPath, { recursive: recursive ?? false, force: false });
      },

      async find(pattern, relativePath, limit) {
        const root = await resolveToolRoot();
        const searchDir = relativePath ? await resolveToolPath(relativePath, { allowMissing: true }) : root;
        const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;

        const all = await walkDir(searchDir, root);
        const matched = all.filter((p) => {
          const name = p.endsWith('/') ? p.slice(0, -1) : p;
          return matchesGlob(name, pattern) || matchesGlob(path.basename(name), pattern);
        });

        if (matched.length === 0) return 'No files found matching pattern';

        const limited = matched.slice(0, effectiveLimit);
        let output = limited.join('\n');

        if (matched.length > effectiveLimit) {
          output += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern.]`;
        }

        return output;
      },

      async grep(pattern, relativePath, options) {
        const root = await resolveToolRoot();
        const searchDir = relativePath ? await resolveToolPath(relativePath, { allowMissing: true }) : root;
        const ignoreCase = options?.ignoreCase ?? false;
        const literal = options?.literal ?? false;
        const contextLines = options?.context ?? 0;
        const effectiveLimit = options?.limit ?? DEFAULT_GREP_LIMIT;

        const files = await walkDir(searchDir, root);
        const flags = ignoreCase ? 'i' : '';
        const escapedPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
        const regex = new RegExp(escapedPattern, flags);

        const outputLines: string[] = [];
        let matchCount = 0;
        let limitReached = false;

        for (const rel of files) {
          if (rel.endsWith('/')) continue;
          if (limitReached) break;
          const abs = path.join(root, rel);
          let content: string;
          try {
            content = await fs.readFile(abs, 'utf-8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matchCount++;
              if (matchCount > effectiveLimit) {
                limitReached = true;
                break;
              }

              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);

              if (outputLines.length > 0 && contextLines > 0) {
                outputLines.push('--');
              }

              for (let j = start; j <= end; j++) {
                const lineText = truncateLine(lines[j], GREP_MAX_LINE_LENGTH);
                if (j === i) {
                  outputLines.push(`${rel}:${j + 1}: ${lineText}`);
                } else {
                  outputLines.push(`${rel}-${j + 1}- ${lineText}`);
                }
              }
            }
          }
        }

        if (matchCount === 0) return 'No matches found';

        let output = outputLines.join('\n');
        if (limitReached) {
          output += `\n\n[${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern]`;
        }

        return output;
      },

      getTabs: () => deps.tabTools.getTabs() as unknown as Promise<{ tabs: Array<{ id: string; title: string; viewId: string | number | null; viewUpdatedAt: number | null; viewChanged: boolean; pinned: boolean; selected: boolean }> }>,
      openTab: (req) => deps.tabTools.openTab(req),
      closeTab: (req) => deps.tabTools.closeTab(req),
      selectTab: (req) => deps.tabTools.selectTab(req),
      reloadTab: (req) => deps.tabTools.reloadTab(req),
      captureTab: (req) => deps.tabTools.captureTab(req),
      getTabConsoleLogs: (req) => deps.tabTools.getTabConsoleLogs(req) as Promise<Array<{ level: 'verbose' | 'info' | 'warning' | 'error'; message: string; timestamp: number }>>,
      execTabJs: (req) => deps.tabTools.execTabJs(req),

      async busPublish(topic, data) {
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed()) {
          deps.forwardBusPublish(win, topic, data);
        }
      },

      async busWaitFor(topic, timeoutMs) {
        const win = deps.getMainWindow();
        if (!win || win.isDestroyed()) {
          throw new Error('Main window is not available');
        }
        return deps.forwardBusWaitFor(win, topic, timeoutMs);
      },

      async spawnAgent(prompt) {
        const win = deps.getMainWindow();
        if (!win || win.isDestroyed()) {
          throw new Error('Main window is not available');
        }
        return deps.forwardSpawnAgent(win, prompt);
      },

      startTask: async (taskId: number) => {
        const runId = await this.startTask(taskId);
        return { runId };
      },

      stopTask: async (runId: string) => {
        this.stopTask(runId);
      },
    };
  }
}

let instance: TaskRunner | null = null;

export function getTaskRunner(): TaskRunner | null {
  return instance;
}

export function initTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  if (instance) {
    instance.disposeAll();
  }
  instance = new TaskRunner(deps);
  return instance;
}
