// Per-agent backup scheduler. Wraps the runtimeRoot-only backup core in
// `#shared/backup.ts` with the Electron-side interval scheduler used by the
// main process. Only local agents schedule backups; remote agents go through
// the daemon's BackupApi.

import { backupAgentDb } from '#shared/backup.js';
import { getConfigValue } from '#shared/settings/config.js';
import { SystemConfigKeys } from '#shared/system-config/keys.js';

export {
  backupAgentDb,
  restoreFromBackup,
  listAllBackups,
  getBackupStatus,
  type BackupStatus,
  type BackupVersionInfo,
  type BackupCreateResult,
  type BackupRestoreResult,
} from '#shared/backup.js';

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
