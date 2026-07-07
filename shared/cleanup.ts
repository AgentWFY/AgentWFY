import { getConfigValue } from './settings/config.js';
import { readSessionId, SESSIONS_RELATIVE_DIR } from './agent/session_persistence.js';
import { isValidTraceSessionId } from './runtime/trace_types.js';
import { TRACES_RELATIVE_DIR } from './runtime/trace_paths.js';
import { TASK_LOGS_RELATIVE_DIR } from './backend/task-logs.js';
import { SystemConfigKeys } from './system-config/keys.js';
import type { FileStore } from './storage/file-store.js';

const TIMESTAMPED_JSON_RE = /^(\d+)-[A-Za-z0-9._-]+\.json$/;

const PRIVATE = { allowPrivate: true } as const;
const REMOVE = { allowPrivate: true, missingOk: true } as const;

/** Remove `<dir>/<ts>-<rand>.json` files older than the retention window,
 *  using the timestamp encoded in the file name. Returns the count removed. */
async function deleteOldFiles(store: FileStore, dir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const entries = await store.list(dir, PRIVATE);
  const toDelete: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const match = entry.name.match(TIMESTAMPED_JSON_RE);
    if (!match) continue;
    if (parseInt(match[1], 10) < cutoff) toDelete.push(`${dir}/${entry.name}`);
  }

  if (toDelete.length === 0) return 0;
  const results = await Promise.allSettled(toDelete.map((key) => store.remove(key, REMOVE)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

async function deleteOldSessionsAndTraces(store: FileStore, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const entries = await store.list(SESSIONS_RELATIVE_DIR, PRIVATE);
  const toDelete: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const match = entry.name.match(TIMESTAMPED_JSON_RE);
    if (!match) continue;
    if (parseInt(match[1], 10) < cutoff) toDelete.push(entry.name);
  }

  if (toDelete.length === 0) return 0;

  // Look up each session's sessionId before deleting, so we can pair-delete
  // the matching trace file from the agent trace directory.
  const sessionIds = await Promise.all(
    toDelete.map((name) => readSessionId(store, name).catch(() => '')),
  );

  const sessionResults = await Promise.allSettled(
    toDelete.map((name) => store.remove(`${SESSIONS_RELATIVE_DIR}/${name}`, REMOVE)),
  );
  const deleted = sessionResults.filter((r) => r.status === 'fulfilled').length;

  const traceRemovals: Array<Promise<unknown>> = [];
  for (let i = 0; i < sessionResults.length; i++) {
    if (sessionResults[i].status !== 'fulfilled') continue;
    const sessionId = sessionIds[i];
    // Reject anything that doesn't match the canonical sessionId shape —
    // a crafted session file could otherwise escape the traces dir via `..`.
    if (!isValidTraceSessionId(sessionId)) continue;
    traceRemovals.push(store.remove(`${TRACES_RELATIVE_DIR}/${sessionId}.jsonl`, REMOVE));
  }
  await Promise.allSettled(traceRemovals);

  return deleted;
}

async function deleteOldTracesByMtime(store: FileStore, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const entries = await store.list(TRACES_RELATIVE_DIR, PRIVATE);
  const toDelete = entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.jsonl') && entry.mtimeMs < cutoff)
    .map((entry) => `${TRACES_RELATIVE_DIR}/${entry.name}`);

  if (toDelete.length === 0) return 0;
  const results = await Promise.allSettled(toDelete.map((key) => store.remove(key, REMOVE)));
  return results.filter((r) => r.status === 'fulfilled').length;
}

export async function runCleanup(runtimeRoot: string, store: FileStore): Promise<void> {
  const sessionDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupSessionRetentionDays, '30'));
  const taskLogDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupTaskLogRetentionDays, '30'));
  const traceDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupTraceRetentionDays, String(sessionDays)));

  // Session sweep removes paired traces first; then a traces sweep by mtime
  // catches anything left behind — task-run traces (no session file at all) and
  // orphans where the session file was removed outside cleanup.
  const [sessionCount, taskLogCount] = await Promise.all([
    deleteOldSessionsAndTraces(store, sessionDays),
    deleteOldFiles(store, TASK_LOGS_RELATIVE_DIR, taskLogDays),
  ]);
  const traceCount = await deleteOldTracesByMtime(store, traceDays);

  if (sessionCount > 0 || taskLogCount > 0 || traceCount > 0) {
    console.log(`[cleanup] Deleted ${sessionCount} old sessions, ${taskLogCount} old task logs, ${traceCount} old traces`);
  }
}
