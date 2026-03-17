import fs from 'fs/promises';
import path from 'path';
import { getConfigValue } from './settings/config.js';

const TIMESTAMPED_JSON_RE = /^(\d+)-[A-Za-z0-9._-]+\.json$/;

async function deleteOldFiles(dir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const toDelete: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(TIMESTAMPED_JSON_RE);
    if (!match) continue;
    const timestamp = parseInt(match[1], 10);
    if (timestamp < cutoff) {
      toDelete.push(path.join(dir, entry.name));
    }
  }

  if (toDelete.length === 0) return 0;

  const results = await Promise.allSettled(toDelete.map((f) => fs.unlink(f)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

export async function runCleanup(agentRoot: string): Promise<void> {
  const sessionDays = getConfigValue(agentRoot, 'system.cleanup.sessionRetentionDays', 30) as number;
  const taskLogDays = getConfigValue(agentRoot, 'system.cleanup.taskLogRetentionDays', 30) as number;

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
