import fs from 'fs/promises';
import path from 'path';
import { getConfigValue } from './settings/config.js';
import { readSessionId } from './agent/session_persistence.js';
import { isValidTraceSessionId } from './runtime/trace_types.js';
import { SystemConfigKeys } from './system-config/keys.js';

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

async function deleteOldSessionsAndTraces(sessionsDir: string, tracesDir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const toDelete: Array<{ file: string; name: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(TIMESTAMPED_JSON_RE);
    if (!match) continue;
    const timestamp = parseInt(match[1], 10);
    if (timestamp < cutoff) {
      toDelete.push({ file: path.join(sessionsDir, entry.name), name: entry.name });
    }
  }

  if (toDelete.length === 0) return 0;

  // Look up each session's sessionId before unlinking, so we can pair-delete
  // the matching trace file from {agentRoot}/.agentwfy/traces/{sessionId}.jsonl.
  const sessionIds = await Promise.all(
    toDelete.map((entry) => readSessionId(sessionsDir, entry.name).catch(() => '')),
  );

  const sessionResults = await Promise.allSettled(toDelete.map((entry) => fs.unlink(entry.file)));
  const deleted = sessionResults.filter((r) => r.status === 'fulfilled').length;

  const traceUnlinks: Array<Promise<unknown>> = [];
  for (let i = 0; i < sessionResults.length; i++) {
    if (sessionResults[i].status !== 'fulfilled') continue;
    const sessionId = sessionIds[i];
    // Reject anything that doesn't match the canonical sessionId shape —
    // a crafted session file could otherwise escape tracesDir via `..`.
    if (!isValidTraceSessionId(sessionId)) continue;
    const tracePath = path.join(tracesDir, sessionId + '.jsonl');
    traceUnlinks.push(fs.unlink(tracePath).catch(() => undefined));
  }
  await Promise.allSettled(traceUnlinks);

  return deleted;
}

async function deleteOldTracesByMtime(tracesDir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries;
  try {
    entries = await fs.readdir(tracesDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const toDelete: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    const full = path.join(tracesDir, entry.name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) toDelete.push(full);
    } catch {
      continue;
    }
  }

  if (toDelete.length === 0) return 0;

  const results = await Promise.allSettled(toDelete.map((f) => fs.unlink(f)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

export async function runCleanup(agentRoot: string): Promise<void> {
  const sessionDays = Number(getConfigValue(agentRoot, SystemConfigKeys.cleanupSessionRetentionDays, '30'));
  const taskLogDays = Number(getConfigValue(agentRoot, SystemConfigKeys.cleanupTaskLogRetentionDays, '30'));
  const traceDays = Number(getConfigValue(agentRoot, SystemConfigKeys.cleanupTraceRetentionDays, String(sessionDays)));

  const sessionsDir = path.join(agentRoot, '.agentwfy', 'sessions');
  const tracesDir = path.join(agentRoot, '.agentwfy', 'traces');
  const taskLogsDir = path.join(agentRoot, '.agentwfy', 'task_logs');

  // Session sweep removes paired traces first; then a tracesDir sweep by mtime
  // catches anything left behind — task-run traces (no session file at all) and
  // orphans where the session file was removed outside cleanup.
  const [sessionCount, taskLogCount] = await Promise.all([
    deleteOldSessionsAndTraces(sessionsDir, tracesDir, sessionDays),
    deleteOldFiles(taskLogsDir, taskLogDays),
  ]);
  const traceCount = await deleteOldTracesByMtime(tracesDir, traceDays);

  if (sessionCount > 0 || taskLogCount > 0 || traceCount > 0) {
    console.log(`[cleanup] Deleted ${sessionCount} old sessions, ${taskLogCount} old task logs, ${traceCount} old traces`);
  }
}
