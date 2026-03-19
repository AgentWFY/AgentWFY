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

export async function ensureSessionsDir(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true })
}

export async function writeSessionFile(sessionsDir: string, fileName: string, content: string): Promise<void> {
  const filePath = path.join(sessionsDir, normalizeSessionFileName(fileName))
  await fs.writeFile(filePath, content, 'utf-8')
}

export async function listSessionFiles(sessionsDir: string, limit: number): Promise<Array<{ name: string; updatedAt: number }>> {
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
    return sessions.slice(0, limit)
  } catch {
    return []
  }
}
