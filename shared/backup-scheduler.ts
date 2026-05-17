// Per-agent backup scheduler around the runtimeRoot-only backup core in
// ./backup.js. Used by both the desktop (for local agents) and the daemon
// (for the remote agent runtime it hosts).

import { backupAgentDb } from './backup.js';
import { getConfigValue } from './settings/config.js';
import { SystemConfigKeys } from './system-config/keys.js';

function getIntervalHours(runtimeRoot: string): number {
  return Number(getConfigValue(runtimeRoot, SystemConfigKeys.backupIntervalHours, '24'));
}

const schedulerIntervals = new Map<string, ReturnType<typeof setInterval>>();

function clearSchedulerForAgent(runtimeRoot: string): void {
  const interval = schedulerIntervals.get(runtimeRoot);
  if (interval) {
    clearInterval(interval);
    schedulerIntervals.delete(runtimeRoot);
  }
}

function startSchedulerInterval(runtimeRoot: string): void {
  const hours = getIntervalHours(runtimeRoot);
  const ms = hours * 60 * 60 * 1000;

  const interval = setInterval(() => {
    backupAgentDb(runtimeRoot).catch((err) => {
      console.error('[backup] Scheduled backup failed:', err);
    });
  }, ms);
  schedulerIntervals.set(runtimeRoot, interval);
}

export async function scheduleBackup(runtimeRoot: string): Promise<void> {
  clearSchedulerForAgent(runtimeRoot);
  await backupAgentDb(runtimeRoot);
  startSchedulerInterval(runtimeRoot);
}

export function rescheduleBackupForAgent(runtimeRoot: string): void {
  if (schedulerIntervals.has(runtimeRoot)) {
    clearSchedulerForAgent(runtimeRoot);
    startSchedulerInterval(runtimeRoot);
  }
}

export function stopBackupSchedulerForAgent(runtimeRoot: string): void {
  clearSchedulerForAgent(runtimeRoot);
}

export function stopBackupScheduler(): void {
  for (const interval of schedulerIntervals.values()) {
    clearInterval(interval);
  }
  schedulerIntervals.clear();
}
