import fs from 'fs/promises';
import path from 'path';
import { storeGet } from './ipc/store.js';

const FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

async function deleteOldFiles(dir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !FILE_NAME_RE.test(entry.name)) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs < cutoff) {
        await fs.unlink(filePath);
        deleted++;
      }
    } catch {
      // Skip files that can't be accessed
    }
  }

  return deleted;
}

export async function runCleanup(agentRoot: string): Promise<void> {
  const sessionDays = Number(storeGet('cleanup.sessionRetentionDays') ?? 30);
  const taskLogDays = Number(storeGet('cleanup.taskLogRetentionDays') ?? 30);

  const sessionsDir = path.join(agentRoot, '.agentwfy', 'sessions');
  const taskLogsDir = path.join(agentRoot, '.agentwfy', 'task_logs');

  const [sessionCount, taskLogCount] = await Promise.all([
    deleteOldFiles(sessionsDir, sessionDays),
    deleteOldFiles(taskLogsDir, taskLogDays),
  ]);

  if (sessionCount > 0 || taskLogCount > 0) {
    console.log(`[cleanup] Deleted ${sessionCount} old sessions, ${taskLogCount} old task logs`);
  }
}
