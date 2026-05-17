import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConfigValue } from './settings/config.js';
import { resolveAgentDbPath } from './db/paths.js';
import { closeAgentDb } from './db/agent-db.js';
import { SystemConfigKeys } from './system-config/keys.js';

const BACKUP_DIR_NAME = 'backups';
const META_FILE_NAME = 'backup-meta.json';

interface BackupMetadata {
  nextVersion: number;
  versions: Record<string, { hash: string; timestamp: string }>;
}

export interface BackupStatus {
  currentVersion: number | null;
  modified: boolean;
  latestBackup: { version: number; timestamp: string } | null;
}

export interface BackupVersionInfo {
  version: number;
  timestamp: string;
  matchesCurrent: boolean;
}

export interface BackupCreateResult {
  created: boolean;
  skipped: boolean;
  version?: number;
  error?: string;
}

export interface BackupRestoreResult {
  success: boolean;
  restoredVersion: number;
  error?: string;
}

function getBackupDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.agentwfy', BACKUP_DIR_NAME);
}

function getMetaPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.agentwfy', META_FILE_NAME);
}

function getDbPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, '.agentwfy', 'agent.db');
}

function getMaxCount(runtimeRoot: string): number {
  return Number(getConfigValue(runtimeRoot, SystemConfigKeys.backupMaxCount, '5'));
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Cache the live DB's SHA-256 keyed by (mtimeMs, size). Both manual and
// scheduled paths call getCurrentDbHash repeatedly; for idle agents the file
// hasn't changed since the last scan and re-reading it is wasted I/O.
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

async function getCurrentDbHash(runtimeRoot: string): Promise<string> {
  const dbPath = getDbPath(runtimeRoot);
  let mtimeMs: number;
  let size: number;
  try {
    const s = await fs.stat(dbPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    hashCache.delete(runtimeRoot);
    return '';
  }
  const cached = hashCache.get(runtimeRoot);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.hash;
  }
  let hash: string;
  try {
    hash = await hashFile(dbPath);
  } catch {
    return '';
  }
  hashCache.set(runtimeRoot, { mtimeMs, size, hash });
  return hash;
}

async function readMeta(runtimeRoot: string): Promise<BackupMetadata> {
  const metaPath = getMetaPath(runtimeRoot);
  try {
    const raw = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    if (typeof raw.nextVersion === 'number' && raw.versions && typeof raw.versions === 'object') {
      return raw as BackupMetadata;
    }
  } catch {}
  return { nextVersion: 1, versions: {} };
}

async function writeMeta(runtimeRoot: string, meta: BackupMetadata): Promise<void> {
  const metaPath = getMetaPath(runtimeRoot);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
}

function getVersionNumbers(meta: BackupMetadata): number[] {
  return Object.keys(meta.versions).map(Number).sort((a, b) => a - b);
}

export async function getBackupStatus(runtimeRoot: string): Promise<BackupStatus> {
  const meta = await readMeta(runtimeRoot);
  const versions = getVersionNumbers(meta);

  if (versions.length === 0) {
    return { currentVersion: null, modified: false, latestBackup: null };
  }

  const latest = versions[versions.length - 1];
  const latestEntry = meta.versions[String(latest)];
  const currentHash = await getCurrentDbHash(runtimeRoot);

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

export async function listAllBackups(runtimeRoot: string): Promise<BackupVersionInfo[]> {
  const meta = await readMeta(runtimeRoot);
  const currentHash = await getCurrentDbHash(runtimeRoot);
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

export async function backupAgentDb(runtimeRoot: string): Promise<BackupCreateResult> {
  const dbPath = await resolveAgentDbPath(runtimeRoot);

  const backupDir = getBackupDir(runtimeRoot);
  await fs.mkdir(backupDir, { recursive: true });

  const meta = await readMeta(runtimeRoot);
  const currentHash = await getCurrentDbHash(runtimeRoot);
  if (!currentHash) {
    return { created: false, skipped: true, error: 'Agent database does not exist' };
  }

  for (const entry of Object.values(meta.versions)) {
    if (entry.hash === currentHash) {
      console.log('[backup] Skipped: no changes since an existing backup');
      return { created: false, skipped: true };
    }
  }

  const version = meta.nextVersion;
  const backupPath = path.join(backupDir, `agent_v${version}.db`);

  try {
    await fs.copyFile(dbPath, backupPath);
    // Hash the copied file, not the pre-copy DB: agent.db may have been
    // mutated mid-copy, so the recorded hash must reflect what's actually
    // on disk in the backup file. The pre-copy hash above is only a cheap
    // dedup hint.
    const backupHash = await hashFile(backupPath);

    meta.versions[String(version)] = { hash: backupHash, timestamp: new Date().toISOString() };
    meta.nextVersion = version + 1;

    const maxCount = getMaxCount(runtimeRoot);
    const sorted = getVersionNumbers(meta);
    if (sorted.length > maxCount) {
      const toRemove = sorted.slice(0, sorted.length - maxCount);
      for (const v of toRemove) {
        const p = path.join(backupDir, `agent_v${v}.db`);
        await fs.unlink(p).catch(() => {});
        delete meta.versions[String(v)];
        console.log(`[backup] Pruned: v${v}`);
      }
    }

    await writeMeta(runtimeRoot, meta);
    console.log(`[backup] Created: v${version}`);
    return { created: true, skipped: false, version };
  } catch (error) {
    console.error('[backup] Failed:', error);
    await fs.unlink(backupPath).catch(() => {});
    return { created: false, skipped: false, error: String(error) };
  }
}

export async function restoreFromBackup(runtimeRoot: string, version: number): Promise<BackupRestoreResult> {
  const meta = await readMeta(runtimeRoot);
  const entry = meta.versions[String(version)];
  if (!entry) {
    return { success: false, restoredVersion: version, error: `Version v${version} not found` };
  }

  const backupDir = getBackupDir(runtimeRoot);
  const backupPath = path.join(backupDir, `agent_v${version}.db`);
  const dbPath = await resolveAgentDbPath(runtimeRoot);

  try {
    await backupAgentDb(runtimeRoot);

    const testDb = new DatabaseSync(backupPath);
    try { testDb.exec('SELECT 1'); } finally { testDb.close(); }

    // Close the live connection before overwriting the file. SQLite would
    // otherwise keep serving cached pages from the pre-restore DB until the
    // connection is recycled.
    closeAgentDb(runtimeRoot);
    await fs.copyFile(backupPath, dbPath);
    hashCache.delete(runtimeRoot);
    console.log(`[backup] Restored to: v${version}`);
    return { success: true, restoredVersion: version };
  } catch (error) {
    console.error('[backup] Restore failed:', error);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { success: false, restoredVersion: version, error: 'Backup file missing from disk' };
    }
    return { success: false, restoredVersion: version, error: String(error) };
  }
}
