import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy.js';
import { Channels } from './channels.js';

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BINARY_BYTES = 20 * 1024 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;
export const DEFAULT_GREP_LIMIT = 100;
export const DEFAULT_FIND_LIMIT = 1000;
export const DEFAULT_LS_LIMIT = 500;

export function truncateText(text: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean; totalLines: number; shownLines: number } {
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

export function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen) + '…';
}

export async function walkDir(dir: string, root: string): Promise<string[]> {
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

export function matchesGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(filename);
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function registerFilesHandlers(getRoot: (e: IpcMainInvokeEvent) => string) {
  const resolveToolPath = (event: IpcMainInvokeEvent, relativePath: string, options?: { allowMissing?: boolean; allowAgentPrivate?: boolean }) =>
    assertPathAllowed(getRoot(event), relativePath, options);
  const resolveToolRoot = (event: IpcMainInvokeEvent) =>
    assertPathAllowed(getRoot(event), '.', { allowMissing: true, allowAgentPrivate: true });

  // read(path, offset?, limit?) → text with line numbers
  ipcMain.handle(Channels.files.read, async (event, relativePath: string, offset?: number, limit?: number) => {
    const filePath = await resolveToolPath(event, relativePath);
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
  ipcMain.handle(Channels.files.write, async (event, relativePath: string, content: string) => {
    const filePath = await resolveToolPath(event, relativePath, { allowMissing: true });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${relativePath}`;
  });

  // writeBinary(path, base64) → success message
  ipcMain.handle(Channels.files.writeBinary, async (event, relativePath: string, base64: string) => {
    const filePath = await resolveToolPath(event, relativePath, { allowMissing: true });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(filePath, buffer);
    return `Successfully wrote ${buffer.length} bytes to ${relativePath}`;
  });

  // readBinary(path) → { base64, mimeType, size }
  ipcMain.handle(Channels.files.readBinary, async (event, relativePath: string) => {
    const filePath = await resolveToolPath(event, relativePath);
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_READ_BINARY_BYTES) {
      throw new Error(`File too large (${stat.size} bytes). readBinary limit is ${MAX_READ_BINARY_BYTES} bytes.`);
    }
    const buffer = await fs.readFile(filePath);
    return {
      base64: buffer.toString('base64'),
      mimeType: mimeFromPath(filePath),
      size: buffer.length,
    };
  });

  // edit(path, oldText, newText) → success message
  ipcMain.handle(Channels.files.edit, async (event, relativePath: string, oldText: string, newText: string) => {
    const filePath = await resolveToolPath(event, relativePath);
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
  ipcMain.handle(Channels.files.ls, async (event, relativePath?: string, limit?: number) => {
    const root = await resolveToolRoot(event);
    const dirPath = await resolveToolPath(event, relativePath || '.');
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
  ipcMain.handle(Channels.files.mkdir, async (event, relativePath: string, recursive?: boolean) => {
    const dirPath = await resolveToolPath(event, relativePath, { allowMissing: true });
    await fs.mkdir(dirPath, { recursive: recursive ?? true });
  });

  // remove(path, recursive?)
  ipcMain.handle(Channels.files.remove, async (event, relativePath: string, recursive?: boolean) => {
    const targetPath = await resolveToolPath(event, relativePath, { allowMissing: true });
    await fs.rm(targetPath, { recursive: recursive ?? false, force: false });
  });

  // find(pattern, path?, limit?) → text list of matching paths
  ipcMain.handle(Channels.files.find, async (event, pattern: string, relativePath?: string, limit?: number) => {
    const root = await resolveToolRoot(event);
    const searchDir = relativePath ? await resolveToolPath(event, relativePath, { allowMissing: true }) : root;
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
  ipcMain.handle(Channels.files.grep, async (
    event,
    pattern: string,
    relativePath?: string,
    options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
  ) => {
    const root = await resolveToolRoot(event);
    const searchDir = relativePath ? await resolveToolPath(event, relativePath, { allowMissing: true }) : root;
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
}
