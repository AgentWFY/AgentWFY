// FileStore helpers for task log persistence. Used by LocalBackend (both
// in-process on the desktop and inside the daemon) so the same layout applies
// regardless of where the agent runs.
//
// Layout: `<root>/.agentwfy/task_logs/<name>.json` (a private subtree, so all
// access passes `{ allowPrivate: true }`).

import type { FileStore } from '../storage/file-store.js'
import type { TaskLogHistoryItem } from './interface.js'

export const TASK_LOGS_RELATIVE_DIR = '.agentwfy/task_logs'
const TASK_LOG_HISTORY_LIMIT = 50
export const TASK_LOG_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/

const PRIVATE = { allowPrivate: true } as const

function normalizeTaskLogFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Task log file name must be a string')
  }
  const normalized = value.trim()
  if (!TASK_LOG_FILE_NAME_RE.test(normalized)) {
    throw new Error('Task log file name must match /^[A-Za-z0-9._-]+\\.json$/')
  }
  return normalized
}

export async function listAgentTaskLogHistory(store: FileStore): Promise<TaskLogHistoryItem[]> {
  const entries = await store.list(TASK_LOGS_RELATIVE_DIR, PRIVATE)

  // Stat-first pass: the listing already carries mtime for every candidate, so
  // pick the newest N and only open those for content. Bounds the work to
  // TASK_LOG_HISTORY_LIMIT regardless of how many old logs accumulate.
  const topCandidates = entries
    .filter((entry) => !entry.isDirectory && TASK_LOG_FILE_NAME_RE.test(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, TASK_LOG_HISTORY_LIMIT)

  const items = await Promise.all(topCandidates.map(async (c): Promise<TaskLogHistoryItem | null> => {
    try {
      const raw = await store.readText(`${TASK_LOGS_RELATIVE_DIR}/${c.name}`, PRIVATE)
      const parsed = JSON.parse(raw)
      return {
        file: c.name,
        updatedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : Math.floor(c.mtimeMs),
        taskName: typeof parsed.taskTitle === 'string' ? parsed.taskTitle : typeof parsed.taskName === 'string' ? parsed.taskName : 'Unknown',
        status: typeof parsed.status === 'string' ? parsed.status : 'unknown',
        origin: parsed.origin ?? undefined,
      }
    } catch {
      return null
    }
  }))

  return items
    .filter((item): item is TaskLogHistoryItem => item !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readAgentTaskLog(store: FileStore, logFileName: string): Promise<string> {
  const normalized = normalizeTaskLogFileName(logFileName)
  return store.readText(`${TASK_LOGS_RELATIVE_DIR}/${normalized}`, PRIVATE)
}
