import fs from 'node:fs';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { runAgentDbSql } from '../db/sqlite.js';
import { resolveInsideRoot } from '../security/path-policy.js';
import { parseExpression, nextMatch } from './scheduler.js';
import type { HttpApiServer, HttpRequestData } from '../http-api/server.js';

interface TriggerRow {
  name: string;
  task_name: string;
  type: 'schedule' | 'http' | 'event';
  config: string;
  description: string;
  enabled: number;
}

interface ScheduleConfig {
  expression: string;
  input?: unknown;
}

interface HttpConfig {
  path: string;
  method?: string;
  input?: unknown;
}

interface EventConfig {
  topic: string;
  input?: unknown;
}

import type { TaskOrigin } from '../task-runner/task_runner.js';

type TriggerOrigin = Extract<TaskOrigin, { type: 'trigger' }>;

interface TriggerEngineDeps {
  getAgentRoot: () => string;
  startTask: (taskName: string, input?: unknown, origin?: TriggerOrigin) => Promise<{ runId: string }>;
  waitFor: (topic: string, timeoutMs?: number) => Promise<unknown>;
  httpApi: HttpApiServer;
  busSubscribe: (topic: string, fn: (data: unknown) => void) => () => void;
  busPublish: (topic: string, data: unknown) => void;
}

type ActiveTrigger = {
  name: string;
  cleanup: () => void;
};

type FileWatcherEntry = {
  watcher: fs.FSWatcher;
  refCount: number;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const FILE_EVENT_RE = /^file:(created|deleted|changed):(.+)$/;
const FILE_DEBOUNCE_MS = 200;

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private activeTriggers: ActiveTrigger[] = [];
  private fileWatchers = new Map<string, FileWatcherEntry>();
  private started = false;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    this.started = true;
    await this.reload();
  }

  stop(): void {
    this.started = false;
    this.teardownAll();
  }

  async reload(): Promise<void> {
    if (!this.started) return;

    this.teardownAll();

    let agentRoot: string;
    try {
      agentRoot = this.deps.getAgentRoot();
    } catch {
      // No agent open yet — nothing to load
      return;
    }

    let rows: TriggerRow[];
    try {
      const raw = await runAgentDbSql(agentRoot, {
        sql: 'SELECT name, task_name, type, config, description, enabled FROM triggers WHERE enabled = 1',
      });
      rows = raw as TriggerRow[];
    } catch (err) {
      console.error('[triggers] Failed to load triggers:', err);
      return;
    }

    for (const row of rows) {
      try {
        const trigger = this.setupTrigger(row);
        if (trigger) {
          this.activeTriggers.push(trigger);
        }
      } catch (err) {
        console.error(`[triggers] Failed to setup trigger ${row.name} (${row.type}):`, err);
      }
    }

    console.log(`[triggers] Loaded ${this.activeTriggers.length} active triggers`);
  }

  private teardownAll(): void {
    for (const trigger of this.activeTriggers) {
      try {
        trigger.cleanup();
      } catch (err) {
        console.error(`[triggers] Cleanup error for trigger ${trigger.name}:`, err);
      }
    }
    this.activeTriggers = [];

    for (const entry of this.fileWatchers.values()) {
      entry.watcher.close();
      for (const timer of entry.debounceTimers.values()) clearTimeout(timer);
    }
    this.fileWatchers.clear();
  }

  private setupTrigger(row: TriggerRow): ActiveTrigger | null {
    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      console.error(`[triggers] Invalid JSON config for trigger ${row.name}`);
      return null;
    }

    switch (row.type) {
      case 'schedule':
        return this.setupSchedule(row.name, row.task_name, config as ScheduleConfig);
      case 'http':
        return this.setupHttp(row.name, row.task_name, config as HttpConfig);
      case 'event':
        return this.setupEvent(row.name, row.task_name, config as EventConfig);
      default:
        console.error(`[triggers] Unknown trigger type: ${row.type}`);
        return null;
    }
  }

  private setupSchedule(triggerName: string, taskName: string, config: ScheduleConfig): ActiveTrigger {
    if (!config.expression || typeof config.expression !== 'string') {
      throw new Error('Schedule trigger requires an "expression" field');
    }

    const parsed = parseExpression(config.expression);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;

      const next = nextMatch(parsed, new Date());
      if (!next) {
        console.error(`[triggers] No next match for trigger ${triggerName} expression "${config.expression}"`);
        return;
      }

      const delay = next.getTime() - Date.now();
      timer = setTimeout(() => {
        if (stopped) return;
        this.deps.startTask(taskName, config.input, { type: 'trigger', triggerName, triggerType: 'schedule', triggerConfig: config.expression }).catch(err => {
          console.error(`[triggers] Schedule trigger ${triggerName} failed to start task ${taskName}:`, err);
        });
        scheduleNext();
      }, Math.max(delay, 0));
    };

    scheduleNext();

    return {
      name: triggerName,
      cleanup: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  private setupHttp(triggerName: string, taskName: string, config: HttpConfig): ActiveTrigger {
    if (!config.path || typeof config.path !== 'string') {
      throw new Error('HTTP trigger requires a "path" field');
    }

    const method = (config.method || 'POST').toUpperCase();
    const routePath = config.path.startsWith('/') ? config.path : `/${config.path}`;
    const triggerConfig = `${method} ${routePath}`;

    const handler = async (request: HttpRequestData): Promise<{ status?: number; body: unknown }> => {
      try {
        const { runId } = await this.deps.startTask(taskName, config.input ?? request, { type: 'trigger', triggerName, triggerType: 'http', triggerConfig });

        // Wait for task completion via bus
        const result = await this.deps.waitFor(`task:run:${runId}`, 120_000) as {
          status: string;
          result?: unknown;
          error?: string;
        } | undefined;

        if (!result) {
          return { status: 504, body: { ok: false, error: 'Task execution timeout' } };
        }

        if (result.status === 'completed') {
          return { body: { ok: true, data: result.result } };
        }

        return { status: 500, body: { ok: false, error: result.error || 'Task failed' } };
      } catch (err) {
        return { status: 500, body: { ok: false, error: (err as Error).message } };
      }
    };

    this.deps.httpApi.registerRoute(routePath, method, handler);

    return {
      name: triggerName,
      cleanup: () => {
        this.deps.httpApi.unregisterRoute(routePath, method);
      },
    };
  }

  private setupEvent(triggerName: string, taskName: string, config: EventConfig): ActiveTrigger {
    if (!config.topic || typeof config.topic !== 'string') {
      throw new Error('Event trigger requires a "topic" field');
    }

    const fileMatch = FILE_EVENT_RE.exec(config.topic);
    let watcherCleanup: (() => void) | null = null;
    if (fileMatch) {
      watcherCleanup = this.ensureFileWatcher(fileMatch[2]);
    }

    const unsubscribe = this.deps.busSubscribe(config.topic, (data: unknown) => {
      this.deps.startTask(taskName, config.input ?? data, { type: 'trigger', triggerName, triggerType: 'event', triggerConfig: config.topic }).catch(err => {
        console.error(`[triggers] Event trigger ${triggerName} failed to start task ${taskName}:`, err);
      });
    });

    return {
      name: triggerName,
      cleanup: () => {
        unsubscribe();
        if (watcherCleanup) watcherCleanup();
      },
    };
  }

  private ensureFileWatcher(dir: string): () => void {
    const agentRoot = this.deps.getAgentRoot();
    const absDir = resolveInsideRoot(agentRoot, dir);

    const existing = this.fileWatchers.get(absDir);
    if (existing) {
      existing.refCount++;
      return this.createWatcherCleanup(absDir, existing);
    }

    fs.mkdirSync(absDir, { recursive: true });

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const watcher = fs.watch(absDir, (eventType, filename) => {
      if (!filename) return;

      const prev = debounceTimers.get(filename);
      if (prev) clearTimeout(prev);

      // Debounce to handle partial writes
      debounceTimers.set(filename, setTimeout(() => {
        debounceTimers.delete(filename);
        const filePath = nodePath.join(absDir, filename);
        const relativePath = nodePath.join(dir, filename);

        if (eventType === 'rename') {
          fsp.access(filePath).then(
            () => this.deps.busPublish(`file:created:${dir}`, { event: 'created', filename, path: relativePath }),
            () => this.deps.busPublish(`file:deleted:${dir}`, { event: 'deleted', filename, path: relativePath }),
          );
        } else if (eventType === 'change') {
          this.deps.busPublish(`file:changed:${dir}`, { event: 'changed', filename, path: relativePath });
        }
      }, FILE_DEBOUNCE_MS));
    });

    watcher.on('error', (err) => {
      console.error(`[triggers] File watcher error for "${dir}":`, err);
    });

    const entry: FileWatcherEntry = { watcher, refCount: 1, debounceTimers };
    this.fileWatchers.set(absDir, entry);
    console.log(`[triggers] Started file watcher for "${dir}"`);

    return this.createWatcherCleanup(absDir, entry);
  }

  private createWatcherCleanup(absDir: string, entry: FileWatcherEntry): () => void {
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.watcher.close();
        for (const timer of entry.debounceTimers.values()) clearTimeout(timer);
        this.fileWatchers.delete(absDir);
      }
    };
  }
}
