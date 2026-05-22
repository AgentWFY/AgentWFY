import { listTasksSync } from '#shared/db/tasks.js';
import { SHORTCUT_PREFIX } from '#shared/system-config/keys.js';
import type { AgentBackend } from '#shared/backend/interface.js';
import type { ActionRegistry } from './registry.js';

const TASK_ACTION_PREFIX = 'task.';
export const TASK_SHORTCUT_KEY_PREFIX = 'shortcuts.task.';

export function isShortcutKey(key: string): boolean {
  return key.startsWith(SHORTCUT_PREFIX) || key.startsWith(TASK_SHORTCUT_KEY_PREFIX);
}

export function taskActionId(taskName: string): string {
  return TASK_ACTION_PREFIX + taskName;
}

export function taskShortcutConfigKey(taskName: string): string {
  return TASK_SHORTCUT_KEY_PREFIX + taskName;
}

export function syncTaskActions(
  registry: ActionRegistry,
  dataDir: string,
  backend: AgentBackend,
): void {
  const agentId = backend.id;
  const tasks = listTasksSync(dataDir);
  const wanted = new Map<string, string>();
  for (const t of tasks) {
    wanted.set(taskActionId(t.name), t.title || t.name);
  }

  for (const def of registry.getAgentBucketActions(agentId)) {
    if (!def.id.startsWith(TASK_ACTION_PREFIX)) continue;
    if (!wanted.has(def.id)) {
      registry.unregisterForAgent(agentId, def.id);
    }
  }

  for (const [id, title] of wanted) {
    const taskName = id.slice(TASK_ACTION_PREFIX.length);
    registry.registerForAgent(agentId, {
      id,
      label: `Run task: ${title}`,
      configKey: taskShortcutConfigKey(taskName),
      run: () => {
        backend.tasks.start({ taskName, origin: { type: 'shortcut' } }).catch((err) => {
          console.error(`[shortcuts] failed to start task ${taskName}:`, err);
        });
      },
    });
  }
}
