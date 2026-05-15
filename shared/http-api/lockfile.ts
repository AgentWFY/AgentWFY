import path from 'path';
import fs from 'fs';

// Inlined from agent-manager.ts to keep this file Electron-free so the runtime
// can use the trigger engine (which depends on this) from non-Electron hosts.
const AGENT_DIR_NAME = '.agentwfy';
const LOCKFILE_NAME = 'http-api.pid';

function lockfilePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, AGENT_DIR_NAME, LOCKFILE_NAME);
}

export function writeLockfile(runtimeRoot: string, port: number): void {
  const data = JSON.stringify({ port, pid: process.pid });
  try {
    fs.writeFileSync(lockfilePath(runtimeRoot), data, 'utf-8');
  } catch (err) {
    console.error('[http-api] Failed to write lockfile:', err);
  }
}

export function removeLockfile(runtimeRoot: string): void {
  try {
    fs.unlinkSync(lockfilePath(runtimeRoot));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[http-api] Failed to remove lockfile:', err);
    }
  }
}

function readLockfile(runtimeRoot: string): { port: number; pid: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath(runtimeRoot), 'utf-8'));
    if (typeof raw?.port === 'number' && typeof raw?.pid === 'number') {
      return { port: raw.port, pid: raw.pid };
    }
  } catch {
    // Missing or malformed
  }
  return null;
}

export function cleanStaleLockfile(runtimeRoot: string): void {
  const lock = readLockfile(runtimeRoot);
  if (!lock) return;

  if (lock.pid === process.pid) return;

  try {
    process.kill(lock.pid, 0); // Check if process is running
    console.warn(`[http-api] Another instance (pid ${lock.pid}) is already serving this agent on port ${lock.port}`);
  } catch {
    // Process is not running — stale lockfile
    console.log(`[http-api] Removing stale lockfile (pid ${lock.pid} no longer running)`);
    removeLockfile(runtimeRoot);
  }
}
