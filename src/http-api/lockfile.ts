import path from 'path';
import fs from 'fs';
import { getAgentDir } from '../agent-manager.js';

const LOCKFILE_NAME = 'http-api.pid';

function lockfilePath(agentRoot: string): string {
  return path.join(getAgentDir(agentRoot), LOCKFILE_NAME);
}

export function writeLockfile(agentRoot: string, port: number): void {
  const data = JSON.stringify({ port, pid: process.pid });
  try {
    fs.writeFileSync(lockfilePath(agentRoot), data, 'utf-8');
  } catch (err) {
    console.error('[http-api] Failed to write lockfile:', err);
  }
}

export function removeLockfile(agentRoot: string): void {
  try {
    fs.unlinkSync(lockfilePath(agentRoot));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[http-api] Failed to remove lockfile:', err);
    }
  }
}

function readLockfile(agentRoot: string): { port: number; pid: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath(agentRoot), 'utf-8'));
    if (typeof raw?.port === 'number' && typeof raw?.pid === 'number') {
      return { port: raw.port, pid: raw.pid };
    }
  } catch {
    // Missing or malformed
  }
  return null;
}

export function cleanStaleLockfile(agentRoot: string): void {
  const lock = readLockfile(agentRoot);
  if (!lock) return;

  if (lock.pid === process.pid) return;

  try {
    process.kill(lock.pid, 0); // Check if process is running
    console.warn(`[http-api] Another instance (pid ${lock.pid}) is already serving this agent on port ${lock.port}`);
  } catch {
    // Process is not running — stale lockfile
    console.log(`[http-api] Removing stale lockfile (pid ${lock.pid} no longer running)`);
    removeLockfile(agentRoot);
  }
}
