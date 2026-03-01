import { app } from 'electron';
import path from 'path';
import { mkdir } from 'fs/promises';
import { storeGet } from './ipc/store';
import { ensureViewsSchema } from './db/views';

export const DEFAULT_DATA_DIR = app.getPath('userData');
const AGENT_DIR_NAME = '.agentwfy';

export function getDataDir(): string {
  const dataDir = storeGet('dataDir');
  return typeof dataDir === 'string' ? dataDir : DEFAULT_DATA_DIR;
}

export function getAgentDir(dataDir: string): string {
  return path.join(dataDir, AGENT_DIR_NAME);
}

export async function ensureAgentDir(dataDir: string): Promise<void> {
  const agentDir = getAgentDir(dataDir);
  try {
    await mkdir(agentDir, { recursive: true });
  } catch (error) {
    console.error(`[agent-runtime] failed to ensure private agent directory at ${agentDir}`, error);
  }
}

export async function ensureAgentRuntimeBootstrap(dataDir: string): Promise<void> {
  await ensureAgentDir(dataDir);
  try {
    await ensureViewsSchema(dataDir);
  } catch (error) {
    console.error(`[agent-runtime] failed to initialize views schema for data dir ${dataDir}`, error);
  }
}
