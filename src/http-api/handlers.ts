import path from 'path';
import fs from 'fs/promises';
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js';
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy.js';
import { walkDir, matchesGlob, truncateLine, GREP_MAX_LINE_LENGTH, DEFAULT_GREP_LIMIT, DEFAULT_FIND_LIMIT, DEFAULT_LS_LIMIT } from '../ipc/files.js';
import type { OnDbChange } from '../db/sqlite.js';

interface GrepMatch {
  file: string;
  line: number;
  text: string;
  context?: string[];
}

interface HandlerDeps {
  getDataDir: () => string;
  onDbChange: OnDbChange;
  startTask: (taskId: number) => Promise<{ runId: string }>;
  busPublish: (topic: string, data: unknown) => void;
}

type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

export function createMethodRegistry(deps: HandlerDeps): Record<string, MethodHandler> {
  const { getDataDir, onDbChange, startTask, busPublish } = deps;

  const resolvePath = (relativePath: string, opts?: { allowMissing?: boolean }) =>
    assertPathAllowed(getDataDir(), relativePath, opts);

  const resolveRoot = () =>
    assertPathAllowed(getDataDir(), '.', { allowMissing: true, allowAgentPrivate: true });

  return {
    'sql.run': async (params) => {
      const request = parseRunSqlRequest(params);
      return routeSqlRequest(getDataDir(), request, onDbChange);
    },

    'files.read': async (params) => {
      const relativePath = requireString(params, 'path');
      const filePath = await resolvePath(relativePath);
      const content = await fs.readFile(filePath, 'utf-8');
      return { content };
    },

    'files.readBinary': async (params) => {
      const relativePath = requireString(params, 'path');
      const filePath = await resolvePath(relativePath);
      const buffer = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return { data: buffer.toString('base64'), mimeType: mimeFromExt(ext) };
    },

    'files.write': async (params) => {
      const relativePath = requireString(params, 'path');
      const content = requireString(params, 'content');
      const filePath = await resolvePath(relativePath, { allowMissing: true });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return { bytes: Buffer.byteLength(content, 'utf-8') };
    },

    'files.writeBinary': async (params) => {
      const relativePath = requireString(params, 'path');
      const data = requireString(params, 'data');
      const filePath = await resolvePath(relativePath, { allowMissing: true });
      const buffer = Buffer.from(data, 'base64');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, buffer);
      return { bytes: buffer.length };
    },

    'files.ls': async (params) => {
      const relativePath = typeof params.path === 'string' ? params.path : '.';
      const root = await resolveRoot();
      const dirPath = await resolvePath(relativePath);
      const limit = typeof params.limit === 'number' ? params.limit : DEFAULT_LS_LIMIT;

      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      const results: { name: string; type: string }[] = [];
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (isAgentPrivatePath(root, entryPath)) continue;
        if (results.length >= limit) break;
        results.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
      return results;
    },

    'files.find': async (params) => {
      const pattern = requireString(params, 'pattern');
      const root = await resolveRoot();
      const searchDir = typeof params.path === 'string'
        ? await resolvePath(params.path, { allowMissing: true })
        : root;
      const limit = typeof params.limit === 'number' ? params.limit : DEFAULT_FIND_LIMIT;

      const all = await walkDir(searchDir, root);
      const matched = all.filter((p) => {
        const name = p.endsWith('/') ? p.slice(0, -1) : p;
        return matchesGlob(name, pattern) || matchesGlob(path.basename(name), pattern);
      });

      return matched.slice(0, limit);
    },

    'files.grep': async (params) => {
      const pattern = requireString(params, 'pattern');
      const root = await resolveRoot();
      const searchDir = typeof params.path === 'string'
        ? await resolvePath(params.path, { allowMissing: true })
        : root;
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const contextLines = typeof params.context === 'number' ? params.context : 0;
      const limit = typeof params.limit === 'number' ? params.limit : DEFAULT_GREP_LIMIT;

      const files = await walkDir(searchDir, root);
      const flags = ignoreCase ? 'i' : '';
      const escapedPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
      const regex = new RegExp(escapedPattern, flags);

      const matches: GrepMatch[] = [];

      for (const rel of files) {
        if (rel.endsWith('/')) continue;
        if (matches.length >= limit) break;
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
            const match: GrepMatch = {
              file: rel,
              line: i + 1,
              text: truncateLine(lines[i], GREP_MAX_LINE_LENGTH),
            };
            if (contextLines > 0) {
              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              match.context = [];
              for (let j = start; j <= end; j++) {
                if (j !== i) match.context.push(truncateLine(lines[j], GREP_MAX_LINE_LENGTH));
              }
            }
            matches.push(match);
            if (matches.length >= limit) break;
          }
        }
      }

      return matches;
    },

    'files.remove': async (params) => {
      const relativePath = requireString(params, 'path');
      const filePath = await resolvePath(relativePath, { allowMissing: true });
      await fs.rm(filePath, { recursive: false, force: false });
    },

    'files.mkdir': async (params) => {
      const relativePath = requireString(params, 'path');
      const dirPath = await resolvePath(relativePath, { allowMissing: true });
      await fs.mkdir(dirPath, { recursive: true });
    },

    'tasks.run': async (params) => {
      const taskId = params.taskId;
      if (typeof taskId !== 'number') {
        throw new Error('Missing required parameter: "taskId" (must be a number)');
      }
      return startTask(taskId);
    },

    'bus.emit': async (params) => {
      const topic = requireString(params, 'topic');
      busPublish(topic, params.data);
    },
  };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required parameter: "${key}" (must be a non-empty string)`);
  }
  return value;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function mimeFromExt(ext: string): string {
  return MIME_TYPES[ext] || 'application/octet-stream';
}
