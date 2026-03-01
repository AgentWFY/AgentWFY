import fs from 'fs/promises';
import path from 'path';
import { assertPathAllowed, resolveInsideRoot } from '../security/path-policy';

const AGENT_DIR_NAME = '.agentwfy';
const AGENT_DB_NAME = 'agent.db';

export async function resolveAgentDbPath(dataDir: string): Promise<string> {
  const agentDir = resolveInsideRoot(dataDir, AGENT_DIR_NAME);
  await fs.mkdir(agentDir, { recursive: true });
  return path.join(agentDir, AGENT_DB_NAME);
}

export async function resolveSqliteFilePath(dataDir: string, requestedPath: string): Promise<string> {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new Error('`path` is required when target is "sqlite-file"');
  }

  const resolvedPath = await assertPathAllowed(dataDir, requestedPath, { allowMissing: true });
  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`SQLite target must be a file: "${requestedPath}"`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }

  return resolvedPath;
}
