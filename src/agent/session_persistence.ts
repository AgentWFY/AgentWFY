import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
export const SESSION_VERSION = 1

export interface StoredSession {
  version: number
  sessionId: string
  providerId: string
  title: string
  providerState: unknown
  updatedAt: number
}

export function createSessionId(): string {
  return crypto.randomUUID()
}

export function createSessionFileName(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}.json`
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

export function normalizeSessionFileName(sessionFile: string): string {
  const normalizedPath = normalizeRelativePath(sessionFile)
  const fileName = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath

  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) {
    throw new Error(`Invalid session file name "${sessionFile}"`)
  }

  return fileName
}

export function parseStoredSession(raw: string, sessionFile: string): StoredSession {
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse session file "${sessionFile}": ${message}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Session file "${sessionFile}" does not contain a JSON object`)
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 0,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : createSessionId(),
    providerId: typeof parsed.providerId === 'string' ? parsed.providerId : '',
    title: typeof parsed.title === 'string' ? parsed.title : '',
    providerState: parsed.providerState ?? null,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
  }
}

export async function readSessionFile(sessionsDir: string, fileName: string): Promise<string> {
  const filePath = path.join(sessionsDir, normalizeSessionFileName(fileName))
  return fs.readFile(filePath, 'utf-8')
}

/**
 * Read the first `byteCount` bytes of a session file and extract the top-level
 * `title` string without parsing the whole JSON. Session files can be tens of
 * megabytes, so full-file reads are too slow for a listing.
 *
 * Relies on JSON.stringify preserving property order: version, sessionId,
 * providerId, title, providerState, updatedAt — so the first `"title"` token
 * in the head of the file is always the top-level title.
 */
export async function readSessionTitle(sessionsDir: string, fileName: string, byteCount = 8192): Promise<string> {
  const head = await readSessionHead(sessionsDir, fileName, byteCount)
  return head ? extractStringFromHead(head, 'title') : ''
}

export async function readSessionId(sessionsDir: string, fileName: string, byteCount = 2048): Promise<string> {
  const head = await readSessionHead(sessionsDir, fileName, byteCount)
  return head ? extractStringFromHead(head, 'sessionId') : ''
}

async function readSessionHead(sessionsDir: string, fileName: string, byteCount: number): Promise<string> {
  const filePath = path.join(sessionsDir, normalizeSessionFileName(fileName))
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(byteCount)
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } catch {
    return ''
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function extractStringFromHead(head: string, key: string): string {
  const needle = `"${key}"`
  const idx = head.indexOf(needle)
  if (idx < 0) return ''

  let i = idx + needle.length
  while (i < head.length && (head[i] === ' ' || head[i] === '\t' || head[i] === '\n' || head[i] === '\r')) i++
  if (head[i] !== ':') return ''
  i++
  while (i < head.length && (head[i] === ' ' || head[i] === '\t' || head[i] === '\n' || head[i] === '\r')) i++
  if (head[i] !== '"') return ''

  const start = i
  i++
  while (i < head.length) {
    const c = head[i]
    if (c === '\\') { i += 2; continue }
    if (c === '"') {
      try {
        const parsed = JSON.parse(head.slice(start, i + 1))
        return typeof parsed === 'string' ? parsed : ''
      } catch {
        return ''
      }
    }
    i++
  }
  return ''
}

export async function ensureSessionsDir(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true })
}

export async function writeSessionFile(sessionsDir: string, fileName: string, content: string): Promise<void> {
  const filePath = path.join(sessionsDir, normalizeSessionFileName(fileName))
  await fs.writeFile(filePath, content, 'utf-8')
}

export async function listSessionFiles(sessionsDir: string): Promise<Array<{ name: string; updatedAt: number }>> {
  try {
    await fs.mkdir(sessionsDir, { recursive: true })
  } catch {
    return []
  }

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true })
    const sessions: Array<{ name: string; updatedAt: number }> = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const stats = await fs.stat(path.join(sessionsDir, entry.name))
        sessions.push({ name: entry.name, updatedAt: Math.floor(stats.mtimeMs) })
      } catch {
        continue
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return sessions
  } catch {
    return []
  }
}
