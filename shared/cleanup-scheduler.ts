// Per-agent periodic cleanup around the one-shot sweep in ./cleanup.js. Runs
// once immediately, then on an interval so long-lived agents (app never quit)
// don't accumulate sessions/traces/task-logs indefinitely between restarts.

import { runCleanup } from './cleanup.js';
import { getConfigValue } from './settings/config.js';
import { SystemConfigKeys } from './system-config/keys.js';
import type { FileStore } from './storage/file-store.js';

function getIntervalHours(runtimeRoot: string): number {
  return Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupIntervalHours, '6'));
}

interface Scheduled {
  interval: ReturnType<typeof setInterval>;
  store: FileStore;
}

const schedulers = new Map<string, Scheduled>();

function clearSchedulerForAgent(runtimeRoot: string): void {
  const scheduled = schedulers.get(runtimeRoot);
  if (scheduled) {
    clearInterval(scheduled.interval);
    schedulers.delete(runtimeRoot);
  }
}

function startSchedulerInterval(runtimeRoot: string, store: FileStore): void {
  const hours = getIntervalHours(runtimeRoot);
  if (!Number.isFinite(hours) || hours <= 0) return;
  const ms = hours * 60 * 60 * 1000;

  const interval = setInterval(() => {
    runCleanup(runtimeRoot, store).catch((err) => {
      console.error('[cleanup] Scheduled cleanup failed:', err);
    });
  }, ms);
  schedulers.set(runtimeRoot, { interval, store });
}

export async function scheduleCleanup(runtimeRoot: string, store: FileStore): Promise<void> {
  clearSchedulerForAgent(runtimeRoot);
  await runCleanup(runtimeRoot, store);
  startSchedulerInterval(runtimeRoot, store);
}

export function rescheduleCleanupForAgent(runtimeRoot: string): void {
  const scheduled = schedulers.get(runtimeRoot);
  if (!scheduled) return;
  const { store } = scheduled;
  clearSchedulerForAgent(runtimeRoot);
  startSchedulerInterval(runtimeRoot, store);
}

export function stopCleanupSchedulerForAgent(runtimeRoot: string): void {
  clearSchedulerForAgent(runtimeRoot);
}

export function stopCleanupScheduler(): void {
  for (const scheduled of schedulers.values()) {
    clearInterval(scheduled.interval);
  }
  schedulers.clear();
}
