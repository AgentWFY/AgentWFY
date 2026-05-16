// Filesystem helpers for task log persistence. Used by LocalBackend (both
// in-process on the desktop and inside the daemon) so the same on-disk layout
// applies regardless of where the agent runs.
//
// On-disk layout: `<runtimeRoot>/.agentwfy/task_logs/<name>.json`.

import fs from 'fs/promises'
import path from 'path'
import { assertPathAllowed } from '../security/path-policy.js'
import type { TaskLogHistoryItem } from './interface.js'

const TASK_LOGS_RELATIVE_DIR = '.agentwfy/task_logs'
const TASK_LOG_HISTORY_LIMIT = 50
const TASK_LOG_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/

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

export async function listAgentTaskLogHistory(runtimeRoot: string): Promise<TaskLogHistoryItem[]> {
  const taskLogsDir = path.join(runtimeRoot, TASK_LOGS_RELATIVE_DIR)

  let entries
  try {
    entries = await fs.readdir(taskLogsDir, { withFileTypes: true })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }

  // Stat-first pass: cheap mtime read for every candidate, then pick the
  // newest N and only open those for content. Bounds the work to
  // TASK_LOG_HISTORY_LIMIT regardless of how many old logs accumulate.
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TASK_LOG_FILE_NAME_RE.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(taskLogsDir, entry.name)
        try {
          const stats = await fs.stat(filePath)
          return { file: entry.name, filePath, mtimeMs: stats.mtimeMs }
        } catch {
          return null
        }
      }),
  )

  const topCandidates = candidates
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, TASK_LOG_HISTORY_LIMIT)

  const items = await Promise.all(topCandidates.map(async (c): Promise<TaskLogHistoryItem | null> => {
    try {
      const raw = await fs.readFile(c.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        file: c.file,
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

export async function readAgentTaskLog(runtimeRoot: string, logFileName: string): Promise<string> {
  const normalized = normalizeTaskLogFileName(logFileName)
  const logPath = await assertPathAllowed(
    runtimeRoot,
    `${TASK_LOGS_RELATIVE_DIR}/${normalized}`,
    { allowAgentPrivate: true },
  )
  return fs.readFile(logPath, 'utf-8')
}
