import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { storeGet } from '../ipc/store.js';
import { ALL_SETTINGS, type SettingDefinition } from './registry.js';

const AGENT_DIR_NAME = '.agentwfy';
const AGENT_DB_NAME = 'agent.db';

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

function getAgentDbPath(agentRoot: string): string {
  return path.join(agentRoot, AGENT_DIR_NAME, AGENT_DB_NAME);
}

function readAgentConfigRaw(agentRoot: string, key: string): unknown {
  const dbPath = getAgentDbPath(agentRoot);
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SCHEMA_SQL);
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.value);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function isValidValue(def: SettingDefinition, value: unknown): boolean {
  if (def.type === 'number' && typeof value !== 'number') return false;
  if (def.type === 'string' && typeof value !== 'string') return false;
  if (def.type === 'boolean' && typeof value !== 'boolean') return false;

  if (def.validate) {
    const error = def.validate(value);
    if (error) return false;
  }

  return true;
}

export function getConfigResolved(agentRoot: string, key: string): { value: unknown; source: 'agent' | 'global' | 'default' } {
  const def = ALL_SETTINGS.find((s) => s.key === key);
  if (!def) return { value: undefined, source: 'default' };

  const agentValue = readAgentConfigRaw(agentRoot, key);
  if (agentValue !== undefined && isValidValue(def, agentValue)) {
    return { value: agentValue, source: 'agent' };
  }

  const globalValue = storeGet(key);
  if (globalValue !== undefined && isValidValue(def, globalValue)) {
    return { value: globalValue, source: 'global' };
  }

  return { value: def.defaultValue, source: 'default' };
}

export function getConfigValue(agentRoot: string, key: string): unknown {
  return getConfigResolved(agentRoot, key).value;
}

export function setAgentConfig(agentRoot: string, key: string, value: unknown): void {
  const dbPath = getAgentDbPath(agentRoot);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  } finally {
    db.close();
  }
}

export function removeAgentConfig(agentRoot: string, key: string): void {
  const dbPath = getAgentDbPath(agentRoot);
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SCHEMA_SQL);
      db.prepare('DELETE FROM config WHERE key = ?').run(key);
    } finally {
      db.close();
    }
  } catch {
    // DB doesn't exist — nothing to remove
  }
}
