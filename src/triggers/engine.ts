import { runAgentDbSql } from '../db/sqlite.js';
import { parseExpression, nextMatch } from './scheduler.js';
import type { HttpApiServer, HttpRequestData } from '../http-api/server.js';

interface TriggerRow {
  id: number;
  task_id: number;
  type: 'schedule' | 'http' | 'event';
  config: string;
  description: string;
  enabled: number;
}

interface ScheduleConfig {
  expression: string;
}

interface HttpConfig {
  path: string;
  method?: string;
}

interface EventConfig {
  topic: string;
}

import type { TaskOrigin } from '../task-runner/task_runner.js';

type TriggerOrigin = Extract<TaskOrigin, { type: 'trigger' }>;

interface TriggerEngineDeps {
  getAgentRoot: () => string;
  startTask: (taskId: number, input?: unknown, origin?: TriggerOrigin) => Promise<{ runId: string }>;
  busWaitFor: (topic: string, timeoutMs?: number) => Promise<unknown>;
  httpApi: HttpApiServer;
  busSubscribe: (topic: string, fn: (data: unknown) => void) => () => void;
}

type ActiveTrigger = {
  id: number;
  cleanup: () => void;
};

export class TriggerEngine {
  private readonly deps: TriggerEngineDeps;
  private activeTriggers: ActiveTrigger[] = [];
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
        sql: 'SELECT id, task_id, type, config, description, enabled FROM triggers WHERE enabled = 1',
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
        console.error(`[triggers] Failed to setup trigger ${row.id} (${row.type}):`, err);
      }
    }

    console.log(`[triggers] Loaded ${this.activeTriggers.length} active triggers`);
  }

  private teardownAll(): void {
    for (const trigger of this.activeTriggers) {
      try {
        trigger.cleanup();
      } catch (err) {
        console.error(`[triggers] Cleanup error for trigger ${trigger.id}:`, err);
      }
    }
    this.activeTriggers = [];
  }

  private setupTrigger(row: TriggerRow): ActiveTrigger | null {
    let config: unknown;
    try {
      config = JSON.parse(row.config);
    } catch {
      console.error(`[triggers] Invalid JSON config for trigger ${row.id}`);
      return null;
    }

    switch (row.type) {
      case 'schedule':
        return this.setupSchedule(row.id, row.task_id, config as ScheduleConfig);
      case 'http':
        return this.setupHttp(row.id, row.task_id, config as HttpConfig);
      case 'event':
        return this.setupEvent(row.id, row.task_id, config as EventConfig);
      default:
        console.error(`[triggers] Unknown trigger type: ${row.type}`);
        return null;
    }
  }

  private setupSchedule(triggerId: number, taskId: number, config: ScheduleConfig): ActiveTrigger {
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
        console.error(`[triggers] No next match for trigger ${triggerId} expression "${config.expression}"`);
        return;
      }

      const delay = next.getTime() - Date.now();
      timer = setTimeout(() => {
        if (stopped) return;
        this.deps.startTask(taskId, undefined, { type: 'trigger', triggerId, triggerType: 'schedule', triggerConfig: config.expression }).catch(err => {
          console.error(`[triggers] Schedule trigger ${triggerId} failed to start task ${taskId}:`, err);
        });
        scheduleNext();
      }, Math.max(delay, 0));
    };

    scheduleNext();

    return {
      id: triggerId,
      cleanup: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  private setupHttp(triggerId: number, taskId: number, config: HttpConfig): ActiveTrigger {
    if (!config.path || typeof config.path !== 'string') {
      throw new Error('HTTP trigger requires a "path" field');
    }

    const method = (config.method || 'POST').toUpperCase();
    const routePath = config.path.startsWith('/') ? config.path : `/${config.path}`;
    const triggerConfig = `${method} ${routePath}`;

    const handler = async (request: HttpRequestData): Promise<{ status?: number; body: unknown }> => {
      try {
        const { runId } = await this.deps.startTask(taskId, request, { type: 'trigger', triggerId, triggerType: 'http', triggerConfig });

        // Wait for task completion via bus
        const result = await this.deps.busWaitFor(`task:run:${runId}`, 120_000) as {
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
      id: triggerId,
      cleanup: () => {
        this.deps.httpApi.unregisterRoute(routePath, method);
      },
    };
  }

  private setupEvent(triggerId: number, taskId: number, config: EventConfig): ActiveTrigger {
    if (!config.topic || typeof config.topic !== 'string') {
      throw new Error('Event trigger requires a "topic" field');
    }

    const unsubscribe = this.deps.busSubscribe(config.topic, (data: unknown) => {
      this.deps.startTask(taskId, data, { type: 'trigger', triggerId, triggerType: 'event', triggerConfig: config.topic }).catch(err => {
        console.error(`[triggers] Event trigger ${triggerId} failed to start task ${taskId}:`, err);
      });
    });

    return {
      id: triggerId,
      cleanup: unsubscribe,
    };
  }
}
