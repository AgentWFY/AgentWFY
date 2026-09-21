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

/** How many filesystem operations a sweep may have in flight at once.
 *
 *  These directories reach hundreds of thousands of entries, and every removal
 *  costs three threadpool operations (the path policy's lstat + realpath, then
 *  the unlink). Firing them all at once buries libuv's four-thread pool, and
 *  unrelated work queues behind the whole sweep — a plain file read has been
 *  measured stalling 7s behind a 150k-file sweep, which is long enough for a
 *  chat message to look like it did nothing at all. A small window makes the
 *  sweep take longer in wall-clock and keeps it off everything else's path. */
const FS_CONCURRENCY = 24;

/** `Promise.allSettled` with a bounded number of operations in flight. */
async function settleWithLimit<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit = FS_CONCURRENCY,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function countFulfilled(results: Array<PromiseSettledResult<unknown>>): number {
  return results.filter((r) => r.status === 'fulfilled').length;
}

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
  return countFulfilled(await settleWithLimit(toDelete, (key) => store.remove(key, REMOVE)));
}

/** Keep only the newest `maxCount` `<ts>-<rand>.json` files in `dir`, deleting
 *  the rest by the timestamp encoded in the file name. `maxCount <= 0` disables
 *  the cap. Guards against a high-frequency task filling the directory faster
 *  than the age-based sweep can retire files. Returns the count removed. */
async function deleteExcessFiles(store: FileStore, dir: string, maxCount: number): Promise<number> {
  if (maxCount <= 0) return 0;

  const entries = await store.list(dir, PRIVATE);
  const timestamped: Array<{ key: string; ts: number }> = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const match = entry.name.match(TIMESTAMPED_JSON_RE);
    if (!match) continue;
    timestamped.push({ key: `${dir}/${entry.name}`, ts: parseInt(match[1], 10) });
  }

  if (timestamped.length <= maxCount) return 0;
  timestamped.sort((a, b) => b.ts - a.ts);
  const toDelete = timestamped.slice(maxCount).map((f) => f.key);
  return countFulfilled(await settleWithLimit(toDelete, (key) => store.remove(key, REMOVE)));
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
  const sessionIdResults = await settleWithLimit(
    toDelete,
    (name) => readSessionId(store, name).catch(() => ''),
  );
  const sessionIds = sessionIdResults.map((r) => (r.status === 'fulfilled' ? r.value : ''));

  const sessionResults = await settleWithLimit(
    toDelete,
    (name) => store.remove(`${SESSIONS_RELATIVE_DIR}/${name}`, REMOVE),
  );
  const deleted = countFulfilled(sessionResults);

  const traceKeys: string[] = [];
  for (let i = 0; i < sessionResults.length; i++) {
    if (sessionResults[i].status !== 'fulfilled') continue;
    const sessionId = sessionIds[i];
    // Reject anything that doesn't match the canonical sessionId shape —
    // a crafted session file could otherwise escape the traces dir via `..`.
    if (!isValidTraceSessionId(sessionId)) continue;
    traceKeys.push(`${TRACES_RELATIVE_DIR}/${sessionId}.jsonl`);
  }
  await settleWithLimit(traceKeys, (key) => store.remove(key, REMOVE));

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
  return countFulfilled(await settleWithLimit(toDelete, (key) => store.remove(key, REMOVE)));
}

export async function runCleanup(runtimeRoot: string, store: FileStore): Promise<void> {
  const sessionDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupSessionRetentionDays, '30'));
  const taskLogDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupTaskLogRetentionDays, '30'));
  const taskLogMaxCount = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupTaskLogMaxCount, '2000'));
  const traceDays = Number(getConfigValue(runtimeRoot, SystemConfigKeys.cleanupTraceRetentionDays, String(sessionDays)));

  // Session sweep removes paired traces first; then a traces sweep by mtime
  // catches anything left behind — task-run traces (no session file at all) and
  // orphans where the session file was removed outside cleanup.
  const [sessionCount, taskLogAgeCount] = await Promise.all([
    deleteOldSessionsAndTraces(store, sessionDays),
    deleteOldFiles(store, TASK_LOGS_RELATIVE_DIR, taskLogDays),
  ]);
  // Age retention can't bound a task that writes logs faster than the window;
  // the count cap keeps the newest N regardless of age.
  const taskLogExcessCount = await deleteExcessFiles(store, TASK_LOGS_RELATIVE_DIR, taskLogMaxCount);
  const taskLogCount = taskLogAgeCount + taskLogExcessCount;
  const traceCount = await deleteOldTracesByMtime(store, traceDays);

  if (sessionCount > 0 || taskLogCount > 0 || traceCount > 0) {
    console.log(`[cleanup] Deleted ${sessionCount} old sessions, ${taskLogCount} old task logs, ${traceCount} old traces`);
  }
}
