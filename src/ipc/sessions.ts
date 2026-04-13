import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed } from '../security/path-policy.js';
import { Channels } from './channels.cjs';

const DEFAULT_SESSION_LIST_LIMIT = 200;
const MAX_SESSION_LIST_LIMIT = 1000;
const SESSION_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

function normalizeSessionFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Session file name must be a string');
  }

  const normalized = value.trim();
  if (!SESSION_FILE_NAME_RE.test(normalized)) {
    throw new Error('Session file name must match /^[A-Za-z0-9._-]+\\.json$/');
  }

  return normalized;
}

export function registerSessionsHandlers(getRoot: (e: IpcMainInvokeEvent) => string) {
  const resolvePrivatePath = (event: IpcMainInvokeEvent, relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(event), relativePath, { ...options, allowAgentPrivate: true });
  const ensureAgentSessionsDir = async (event: IpcMainInvokeEvent): Promise<string> => {
    const sessionsDir = await resolvePrivatePath(event, '.agentwfy/sessions', { allowMissing: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    return sessionsDir;
  };
  const resolveAgentSessionPath = (event: IpcMainInvokeEvent, sessionFileName: string, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(event, `.agentwfy/sessions/${normalizeSessionFileName(sessionFileName)}`, options);

  // listSessions(limit?) → [{ name, updatedAt }]
  ipcMain.handle(Channels.sessions.list, async (event, limit?: number) => {
    const sessionsDir = await ensureAgentSessionsDir(event);
    const requestedLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.floor(limit)
      : DEFAULT_SESSION_LIST_LIMIT;
    const effectiveLimit = Math.max(1, Math.min(requestedLimit, MAX_SESSION_LIST_LIMIT));

    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const sessions: Array<{ name: string; updatedAt: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SESSION_FILE_NAME_RE.test(entry.name)) continue;

      const filePath = path.join(sessionsDir, entry.name);
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        continue;
      }

      sessions.push({
        name: entry.name,
        updatedAt: Math.floor(stats.mtimeMs),
      });
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions.slice(0, effectiveLimit);
  });

  // readSession(sessionFileName) → file content
  ipcMain.handle(Channels.sessions.read, async (event, sessionFileName: string) => {
    const sessionPath = await resolveAgentSessionPath(event, sessionFileName);
    return fs.readFile(sessionPath, 'utf-8');
  });

  // writeSession(sessionFileName, content)
  ipcMain.handle(Channels.sessions.write, async (event, sessionFileName: string, content: string) => {
    const sessionPath = await resolveAgentSessionPath(event, sessionFileName, { allowMissing: true });
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, content, 'utf-8');
  });
}
