import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConfigValue } from '#shared/settings/config.js';
import { resolveAgentDbPath } from '#shared/db/paths.js';
import { SystemConfigKeys } from '#shared/system-config/keys.js';

const BACKUP_DIR_NAME = 'backups';
const META_FILE_NAME = 'backup-meta.json';

// --- Types ---

interface BackupMetadata {
  nextVersion: number;
  versions: Record<string, { hash: string; timestamp: string }>;
}

interface BackupStatus {
  currentVersion: number | null;
  modified: boolean;
  latestBackup: { version: number; timestamp: string } | null;
}

interface BackupVersionInfo {
  version: number;
  timestamp: string;
  matchesCurrent: boolean;
}

// --- Helpers ---

function getBackupDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.agentwfy', BACKUP_DIR_NAME);
}

function getMetaPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.agentwfy', META_FILE_NAME);
}

function getIntervalHours(runtimeRoot: string): number {
  return Number(getConfigValue(runtimeRoot, SystemConfigKeys.backupIntervalHours, '24'));
}

function getMaxCount(runtimeRoot: string): number {
  return Number(getConfigValue(runtimeRoot, SystemConfigKeys.backupMaxCount, '5'));
}

function fileHash(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '';
  }
}

function readMeta(runtimeRoot: string): BackupMetadata {
  const metaPath = getMetaPath(runtimeRoot);
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (typeof raw.nextVersion === 'number' && raw.versions && typeof raw.versions === 'object') {
      return raw as BackupMetadata;
    }
  } catch {}
  return { nextVersion: 1, versions: {} };
}

function writeMeta(runtimeRoot: string, meta: BackupMetadata): void {
  const metaPath = getMetaPath(runtimeRoot);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function getVersionNumbers(meta: BackupMetadata): number[] {
  return Object.keys(meta.versions).map(Number).sort((a, b) => a - b);
}

// --- Public API ---

function getCurrentDbHash(runtimeRoot: string): string {
  return fileHash(path.join(runtimeRoot, '.agentwfy', 'agent.db'));
}

export function getBackupStatus(runtimeRoot: string): BackupStatus {
  const meta = readMeta(runtimeRoot);
  const versions = getVersionNumbers(meta);

  if (versions.length === 0) {
    return { currentVersion: null, modified: false, latestBackup: null };
  }

  const latest = versions[versions.length - 1];
  const latestEntry = meta.versions[String(latest)];
  const currentHash = getCurrentDbHash(runtimeRoot);

  // Find which version matches current DB (check latest first, then others)
  let matchedVersion: number | null = null;
  if (currentHash && latestEntry.hash === currentHash) {
    matchedVersion = latest;
  } else if (currentHash) {
    for (let i = versions.length - 1; i >= 0; i--) {
      if (meta.versions[String(versions[i])].hash === currentHash) {
        matchedVersion = versions[i];
        break;
      }
    }
  }

  return {
    currentVersion: matchedVersion,
    modified: matchedVersion === null,
    latestBackup: { version: latest, timestamp: latestEntry.timestamp },
  };
}

export function listAllBackups(runtimeRoot: string): BackupVersionInfo[] {
  const meta = readMeta(runtimeRoot);
  const currentHash = getCurrentDbHash(runtimeRoot);
  const versions = getVersionNumbers(meta);

  return versions
    .map((v) => {
      const entry = meta.versions[String(v)];
      return {
        version: v,
        timestamp: entry.timestamp,
        matchesCurrent: currentHash !== '' && entry.hash === currentHash,
      };
    })
    .reverse();
}

export async function backupAgentDb(runtimeRoot: string): Promise<{ created: boolean; skipped: boolean; version?: number; error?: string }> {
  const dbPath = await resolveAgentDbPath(runtimeRoot);
  if (!fs.existsSync(dbPath)) {
    return { created: false, skipped: true, error: 'Agent database does not exist' };
  }

  const backupDir = getBackupDir(runtimeRoot);
  fs.mkdirSync(backupDir, { recursive: true });

  const meta = readMeta(runtimeRoot);
  const currentHash = getCurrentDbHash(runtimeRoot);

  // Skip if any existing version already has this hash
  if (currentHash) {
    for (const entry of Object.values(meta.versions)) {
      if (entry.hash === currentHash) {
        console.log('[backup] Skipped: no changes since an existing backup');
        return { created: false, skipped: true };
      }
    }
  }

  const version = meta.nextVersion;
  const backupPath = path.join(backupDir, `agent_v${version}.db`);

  try {
    fs.copyFileSync(dbPath, backupPath);

    meta.versions[String(version)] = { hash: currentHash, timestamp: new Date().toISOString() };
    meta.nextVersion = version + 1;

    // Prune oldest versions beyond maxCount
    const maxCount = getMaxCount(runtimeRoot);
    const sorted = getVersionNumbers(meta);
    if (sorted.length > maxCount) {
      const toRemove = sorted.slice(0, sorted.length - maxCount);
      for (const v of toRemove) {
        const p = path.join(backupDir, `agent_v${v}.db`);
        try { fs.unlinkSync(p); } catch {}
        delete meta.versions[String(v)];
        console.log(`[backup] Pruned: v${v}`);
      }
    }

    writeMeta(runtimeRoot, meta);
    console.log(`[backup] Created: v${version}`);
    return { created: true, skipped: false, version };
  } catch (error) {
    console.error('[backup] Failed:', error);
    // Clean up partial backup if it was written
    if (fs.existsSync(backupPath)) {
      try { fs.unlinkSync(backupPath); } catch {}
    }
    return { created: false, skipped: false, error: String(error) };
  }
}

export async function restoreFromBackup(runtimeRoot: string, version: number): Promise<{ success: boolean; restoredVersion: number; error?: string }> {
  const meta = readMeta(runtimeRoot);
  const entry = meta.versions[String(version)];
  if (!entry) {
    return { success: false, restoredVersion: version, error: `Version v${version} not found` };
  }

  const backupDir = getBackupDir(runtimeRoot);
  const backupPath = path.join(backupDir, `agent_v${version}.db`);
  const dbPath = await resolveAgentDbPath(runtimeRoot);

  if (!fs.existsSync(backupPath)) {
    return { success: false, restoredVersion: version, error: 'Backup file missing from disk' };
  }

  try {
    // Auto-backup current state first (will skip if unchanged)
    await backupAgentDb(runtimeRoot);

    // Verify backup is valid SQLite
    const testDb = new DatabaseSync(backupPath);
    try { testDb.exec('SELECT 1'); } finally { testDb.close(); }

    fs.copyFileSync(backupPath, dbPath);
    console.log(`[backup] Restored to: v${version}`);
    return { success: true, restoredVersion: version };
  } catch (error) {
    console.error('[backup] Restore failed:', error);
    return { success: false, restoredVersion: version, error: String(error) };
  }
}

// --- Scheduler ---

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
