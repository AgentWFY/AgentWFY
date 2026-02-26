import { ipcMain, BrowserWindow, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy';
import { parseRunSqlRequest, routeSqlRequest } from '../services/sql-router';

// --- Constants ---

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;
const MAX_LOG_BUFFER = 1000;
const DEFAULT_SESSION_LIST_LIMIT = 200;
const MAX_SESSION_LIST_LIMIT = 1000;
const SESSION_FILE_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

// --- Console log buffer ---

interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: number;
}

const consoleLogs: ConsoleLogEntry[] = [];

const LOG_LEVEL_MAP: Record<number, string> = {
  0: 'verbose',
  1: 'info',
  2: 'warning',
  3: 'error',
};

interface CaptureViewRequest {
  viewId: string | number
}

interface GetViewConsoleLogsRequest {
  viewId: string | number
  since?: number
  limit?: number
}

interface ExecViewJsRequest {
  viewId: string | number
  code: string
  timeoutMs?: number
}

interface AgentViewTools {
  captureView?: (request: CaptureViewRequest) => Promise<{ base64: string; mimeType: 'image/png' }>
  getViewConsoleLogs?: (request: GetViewConsoleLogsRequest) => Promise<Array<{ level: string; message: string; timestamp: number }>>
  execViewJs?: (request: ExecViewJsRequest) => Promise<any>
}

// --- Channels ---

const Channel = {
  READ: 'electronAgentTools:read',
  WRITE: 'electronAgentTools:write',
  EDIT: 'electronAgentTools:edit',
  LS: 'electronAgentTools:ls',
  MKDIR: 'electronAgentTools:mkdir',
  REMOVE: 'electronAgentTools:remove',
  FIND: 'electronAgentTools:find',
  GREP: 'electronAgentTools:grep',
  LIST_SESSIONS: 'electronAgentTools:listSessions',
  READ_SESSION: 'electronAgentTools:readSession',
  WRITE_SESSION: 'electronAgentTools:writeSession',
  READ_AUTH_CONFIG: 'electronAgentTools:readAuthConfig',
  WRITE_AUTH_CONFIG: 'electronAgentTools:writeAuthConfig',
  READ_LEGACY_API_KEY: 'electronAgentTools:readLegacyApiKey',
  RUN_SQL: 'electronAgentTools:runSql',
  CAPTURE_VIEW: 'electronAgentTools:captureView',
  GET_VIEW_CONSOLE_LOGS: 'electronAgentTools:getViewConsoleLogs',
  EXEC_VIEW_JS: 'electronAgentTools:execViewJs',
  CAPTURE_WINDOW_PNG: 'electronAgentTools:captureWindowPng',
  GET_CONSOLE_LOGS: 'electronAgentTools:getConsoleLogs',
} as const;

// --- Helpers ---

function truncateText(text: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean; totalLines: number; shownLines: number } {
  const lines = text.split('\n');
  const totalLines = lines.length;

  let byteCount = 0;
  let lineCount = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (byteCount + lineBytes > maxBytes && i > 0) break;
    byteCount += lineBytes;
    lineCount++;
  }

  if (lineCount >= totalLines) {
    return { content: text, truncated: false, totalLines, shownLines: totalLines };
  }

  return {
    content: lines.slice(0, lineCount).join('\n'),
    truncated: true,
    totalLines,
    shownLines: lineCount,
  };
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen) + '…';
}

async function walkDir(dir: string, root: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (isAgentPrivatePath(root, full)) continue;
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      results.push(rel + '/');
      results.push(...await walkDir(full, root));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function matchesGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(filename);
}

function parseViewId(value: unknown): string | number {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  throw new Error('viewId must be a non-empty string or number');
}

function parseOptionalNumber(value: unknown, label: string): number | undefined {
  if (typeof value === 'undefined' || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number when provided`);
  }

  return value;
}

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

// --- Handler registration ---

export function registerAgentToolsHandlers(
  getRoot: () => string,
  getMainWindow: () => BrowserWindow | null,
  viewTools?: AgentViewTools
) {
  const resolveToolPath = (relativePath: string, options?: { allowMissing?: boolean; allowAgentPrivate?: boolean }) =>
    assertPathAllowed(getRoot(), relativePath, options);
  const resolveToolRoot = () =>
    assertPathAllowed(getRoot(), '.', { allowMissing: true, allowAgentPrivate: true });
  const resolvePrivatePath = (relativePath: string, options?: { allowMissing?: boolean }) =>
    assertPathAllowed(getRoot(), relativePath, { ...options, allowAgentPrivate: true });
  const ensureAgentSessionsDir = async (): Promise<string> => {
    const sessionsDir = await resolvePrivatePath('.agent/sessions', { allowMissing: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    return sessionsDir;
  };
  const resolveAgentSessionPath = (sessionFileName: string, options?: { allowMissing?: boolean }) =>
    resolvePrivatePath(`.agent/sessions/${normalizeSessionFileName(sessionFileName)}`, options);
  const resolveAuthConfigPath = (options?: { allowMissing?: boolean }) =>
    resolvePrivatePath('.agent/config/auth.json', options);
  const resolveLegacyApiKeyPath = () =>
    resolvePrivatePath('.agent/config/api_key');

  // read(path, offset?, limit?) → text with line numbers
  ipcMain.handle(Channel.READ, async (_event, relativePath: string, offset?: number, limit?: number) => {
    const filePath = await resolveToolPath(relativePath);
    const raw = await fs.readFile(filePath, 'utf-8');
    const allLines = raw.split('\n');
    const totalLines = allLines.length;

    const startLine = offset ? Math.max(0, offset - 1) : 0;
    if (startLine >= totalLines) {
      throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
    }

    const effectiveLimit = limit ?? MAX_READ_LINES;
    const endLine = Math.min(startLine + effectiveLimit, totalLines);
    const selected = allLines.slice(startLine, endLine).join('\n');

    const trunc = truncateText(selected, effectiveLimit, MAX_READ_BYTES);
    const actualEnd = startLine + trunc.shownLines;

    let output = trunc.content;

    if (trunc.truncated || actualEnd < totalLines) {
      const nextOffset = actualEnd + 1;
      output += `\n\n[Showing lines ${startLine + 1}-${actualEnd} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
    }

    return output;
  });

  // write(path, content) → success message
  ipcMain.handle(Channel.WRITE, async (_event, relativePath: string, content: string) => {
    const filePath = await resolveToolPath(relativePath, { allowMissing: true });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${relativePath}`;
  });

  // edit(path, oldText, newText) → success message
  ipcMain.handle(Channel.EDIT, async (_event, relativePath: string, oldText: string, newText: string) => {
    const filePath = await resolveToolPath(relativePath);
    const content = await fs.readFile(filePath, 'utf-8');
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      throw new Error(`Could not find the exact text in ${relativePath}. The old text must match exactly including all whitespace and newlines.`);
    }
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of the text in ${relativePath}. The text must be unique. Provide more context to make it unique.`);
    }
    const updated = content.replace(oldText, newText);
    await fs.writeFile(filePath, updated, 'utf-8');
    return `Successfully replaced text in ${relativePath}`;
  });

  // ls(path?, limit?) → sorted text, dirs have / suffix
  ipcMain.handle(Channel.LS, async (_event, relativePath?: string, limit?: number) => {
    const root = await resolveToolRoot();
    const dirPath = await resolveToolPath(relativePath || '.');
    const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const results: string[] = [];
    let limitReached = false;

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (isAgentPrivatePath(root, entryPath)) continue;
      if (results.length >= effectiveLimit) {
        limitReached = true;
        break;
      }
      results.push(entry.isDirectory() ? entry.name + '/' : entry.name);
    }

    if (results.length === 0) return '(empty directory)';

    let output = results.join('\n');
    if (limitReached) {
      output += `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more.]`;
    }
    return output;
  });

  // mkdir(path, recursive?)
  ipcMain.handle(Channel.MKDIR, async (_event, relativePath: string, recursive?: boolean) => {
    const dirPath = await resolveToolPath(relativePath, { allowMissing: true });
    await fs.mkdir(dirPath, { recursive: recursive ?? true });
  });

  // remove(path, recursive?)
  ipcMain.handle(Channel.REMOVE, async (_event, relativePath: string, recursive?: boolean) => {
    const targetPath = await resolveToolPath(relativePath, { allowMissing: true });
    await fs.rm(targetPath, { recursive: recursive ?? false, force: false });
  });

  // find(pattern, path?, limit?) → text list of matching paths
  ipcMain.handle(Channel.FIND, async (_event, pattern: string, relativePath?: string, limit?: number) => {
    const root = await resolveToolRoot();
    const searchDir = relativePath ? await resolveToolPath(relativePath, { allowMissing: true }) : root;
    const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;

    const all = await walkDir(searchDir, root);
    const matched = all.filter((p) => {
      const name = p.endsWith('/') ? p.slice(0, -1) : p;
      return matchesGlob(name, pattern) || matchesGlob(path.basename(name), pattern);
    });

    if (matched.length === 0) return 'No files found matching pattern';

    const limited = matched.slice(0, effectiveLimit);
    let output = limited.join('\n');

    if (matched.length > effectiveLimit) {
      output += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern.]`;
    }

    return output;
  });

  // grep(pattern, path?, options?) → formatted text matches
  ipcMain.handle(Channel.GREP, async (
    _event,
    pattern: string,
    relativePath?: string,
    options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
  ) => {
    const root = await resolveToolRoot();
    const searchDir = relativePath ? await resolveToolPath(relativePath, { allowMissing: true }) : root;
    const ignoreCase = options?.ignoreCase ?? false;
    const literal = options?.literal ?? false;
    const contextLines = options?.context ?? 0;
    const effectiveLimit = options?.limit ?? DEFAULT_GREP_LIMIT;

    const files = await walkDir(searchDir, root);
    const flags = ignoreCase ? 'i' : '';
    const escapedPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    const regex = new RegExp(escapedPattern, flags);

    const outputLines: string[] = [];
    let matchCount = 0;
    let limitReached = false;

    for (const rel of files) {
      if (rel.endsWith('/')) continue;
      if (limitReached) break;
      const abs = path.join(root, rel);
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matchCount++;
          if (matchCount > effectiveLimit) {
            limitReached = true;
            break;
          }

          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);

          if (outputLines.length > 0 && contextLines > 0) {
            outputLines.push('--');
          }

          for (let j = start; j <= end; j++) {
            const lineText = truncateLine(lines[j], GREP_MAX_LINE_LENGTH);
            if (j === i) {
              outputLines.push(`${rel}:${j + 1}: ${lineText}`);
            } else {
              outputLines.push(`${rel}-${j + 1}- ${lineText}`);
            }
          }
        }
      }
    }

    if (matchCount === 0) return 'No matches found';

    let output = outputLines.join('\n');
    const notices: string[] = [];

    if (limitReached) {
      notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    }

    if (notices.length > 0) {
      output += `\n\n[${notices.join('. ')}]`;
    }

    return output;
  });

  // listSessions(limit?) → [{ name, updatedAt }]
  ipcMain.handle(Channel.LIST_SESSIONS, async (_event, limit?: number) => {
    const sessionsDir = await ensureAgentSessionsDir();
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
  ipcMain.handle(Channel.READ_SESSION, async (_event, sessionFileName: string) => {
    const sessionPath = await resolveAgentSessionPath(sessionFileName);
    return fs.readFile(sessionPath, 'utf-8');
  });

  // writeSession(sessionFileName, content)
  ipcMain.handle(Channel.WRITE_SESSION, async (_event, sessionFileName: string, content: string) => {
    const sessionPath = await resolveAgentSessionPath(sessionFileName, { allowMissing: true });
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, content, 'utf-8');
  });

  // readAuthConfig() → auth config json string
  ipcMain.handle(Channel.READ_AUTH_CONFIG, async () => {
    const authConfigPath = await resolveAuthConfigPath();
    return fs.readFile(authConfigPath, 'utf-8');
  });

  // writeAuthConfig(content)
  ipcMain.handle(Channel.WRITE_AUTH_CONFIG, async (_event, content: string) => {
    const authConfigPath = await resolveAuthConfigPath({ allowMissing: true });
    await fs.mkdir(path.dirname(authConfigPath), { recursive: true });
    await fs.writeFile(authConfigPath, content, 'utf-8');
  });

  // readLegacyApiKey() → legacy api key string
  ipcMain.handle(Channel.READ_LEGACY_API_KEY, async () => {
    const legacyApiKeyPath = await resolveLegacyApiKeyPath();
    return fs.readFile(legacyApiKeyPath, 'utf-8');
  });

  // runSql({ target, path?, sql, params?, description?, confirmed? }) → query result
  ipcMain.handle(Channel.RUN_SQL, async (_event, payload: unknown) => {
    const request = parseRunSqlRequest(payload);
    return routeSqlRequest(getRoot(), request);
  });

  // captureView({ viewId }) → { base64, mimeType }
  ipcMain.handle(Channel.CAPTURE_VIEW, async (_event, payload: unknown) => {
    if (!viewTools?.captureView) {
      throw new Error('captureView is not available in this runtime');
    }

    const input = payload as CaptureViewRequest | undefined;
    const viewId = parseViewId(input?.viewId);
    return viewTools.captureView({ viewId });
  });

  // getViewConsoleLogs({ viewId, since?, limit? }) → logs[]
  ipcMain.handle(Channel.GET_VIEW_CONSOLE_LOGS, async (_event, payload: unknown) => {
    if (!viewTools?.getViewConsoleLogs) {
      throw new Error('getViewConsoleLogs is not available in this runtime');
    }

    const input = payload as GetViewConsoleLogsRequest | undefined;
    const viewId = parseViewId(input?.viewId);
    const since = parseOptionalNumber(input?.since, 'since');
    const limit = parseOptionalNumber(input?.limit, 'limit');
    if (typeof limit === 'number' && limit < 1) {
      throw new Error('limit must be >= 1 when provided');
    }

    return viewTools.getViewConsoleLogs({
      viewId,
      since,
      limit,
    });
  });

  // execViewJs({ viewId, code, timeoutMs? }) → execution result
  ipcMain.handle(Channel.EXEC_VIEW_JS, async (_event, payload: unknown) => {
    if (!viewTools?.execViewJs) {
      throw new Error('execViewJs is not available in this runtime');
    }

    const input = payload as ExecViewJsRequest | undefined;
    const viewId = parseViewId(input?.viewId);
    if (!input || typeof input.code !== 'string') {
      throw new Error('execViewJs requires code as a string');
    }

    const timeoutMs = parseOptionalNumber(input.timeoutMs, 'timeoutMs');
    if (typeof timeoutMs === 'number' && timeoutMs < 1) {
      throw new Error('timeoutMs must be >= 1 when provided');
    }

    return viewTools.execViewJs({
      viewId,
      code: input.code,
      timeoutMs,
    });
  });

  // Console log capture
  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('console-message', (_e, level, message) => {
      consoleLogs.push({ level: LOG_LEVEL_MAP[level] || 'info', message, timestamp: Date.now() });
      if (consoleLogs.length > MAX_LOG_BUFFER) {
        consoleLogs.splice(0, consoleLogs.length - MAX_LOG_BUFFER);
      }
    });
  });

  // getConsoleLogs(since?) → array of log entries
  ipcMain.handle(Channel.GET_CONSOLE_LOGS, async (_event, since?: number) => {
    if (since) {
      return consoleLogs.filter((e) => e.timestamp > since);
    }
    return consoleLogs.slice();
  });

  // captureWindowPng() → { path, base64 }
  ipcMain.handle(Channel.CAPTURE_WINDOW_PNG, async () => {
    const win = getMainWindow();
    if (!win) throw new Error('No main window available');
    const image = await win.webContents.capturePage();
    const pngBuffer = image.toPNG();
    const filename = `screenshot-${Date.now()}.png`;
    const tmpDir = await resolveToolPath('tmp', { allowMissing: true });
    const savePath = path.join(tmpDir, filename);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(savePath, pngBuffer);
    return { path: savePath, base64: pngBuffer.toString('base64') };
  });
}
