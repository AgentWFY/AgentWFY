import { listTasksSync } from '../db/tasks.js';
import type { TaskRunner } from '../task-runner/task_runner.js';
import type { ActionRegistry } from './registry.js';

const TASK_ACTION_PREFIX = 'task.';
export const TASK_SHORTCUT_KEY_PREFIX = 'shortcuts.task.';

export function taskActionId(taskName: string): string {
  return TASK_ACTION_PREFIX + taskName;
}

export function taskShortcutConfigKey(taskName: string): string {
  return TASK_SHORTCUT_KEY_PREFIX + taskName;
}

export function syncTaskActions(
  registry: ActionRegistry,
  agentRoot: string,
  taskRunner: TaskRunner,
): void {
  const tasks = listTasksSync(agentRoot);
  const wanted = new Map<string, string>();
  for (const t of tasks) {
    wanted.set(taskActionId(t.name), t.title || t.name);
  }

  for (const def of registry.getAgentBucketActions(agentRoot)) {
    if (!def.id.startsWith(TASK_ACTION_PREFIX)) continue;
    if (!wanted.has(def.id)) {
      registry.unregisterForAgent(agentRoot, def.id);
    }
  }

  for (const [id, title] of wanted) {
    const taskName = id.slice(TASK_ACTION_PREFIX.length);
    registry.registerForAgent(agentRoot, {
      id,
      label: `Run task: ${title}`,
      configKey: taskShortcutConfigKey(taskName),
      run: () => {
        taskRunner.startTask(taskName, undefined, { type: 'shortcut' }).catch((err) => {
          console.error(`[shortcuts] failed to start task ${taskName}:`, err);
        });
      },
    });
  }
}
