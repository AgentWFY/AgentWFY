import { storeGet } from '../ipc/store.js';
import { getOrCreateAgentDb } from '../db/agent-db.js';

function readAgentConfigValue(agentRoot: string, name: string): unknown {
  try {
    const rows = getOrCreateAgentDb(agentRoot).run({
      sql: 'SELECT value FROM config WHERE name = ?',
      params: [name],
    });
    if (rows.length === 0) return undefined;
    const row = rows[0] as Record<string, unknown>;
    if (row.value === null) return undefined;
    return JSON.parse(row.value as string);
  } catch {
    return undefined;
  }
}

export function getConfigValue(agentRoot: string, name: string, fallback?: unknown): unknown {
  const agentValue = readAgentConfigValue(agentRoot, name);
  if (agentValue !== undefined) return agentValue;

  const globalValue = storeGet(name);
  if (globalValue !== undefined) return globalValue;

  return fallback;
}

export function setAgentConfig(agentRoot: string, name: string, value: unknown): void {
  const db = getOrCreateAgentDb(agentRoot);
  const jsonValue = JSON.stringify(value);
  // UPDATE first — works for all existing rows (including guarded system/plugin rows)
  db.run({ sql: 'UPDATE config SET value = ? WHERE name = ?', params: [jsonValue, name] });
  // INSERT for new user rows — guard blocks this for system/plugin, but those already exist from sync
  try {
    db.run({ sql: 'INSERT INTO config (name, value) VALUES (?, ?)', params: [name, jsonValue] });
  } catch {
    // Row already exists (UPDATE handled it) or guard blocked system/plugin INSERT
  }
}

export function clearAgentConfig(agentRoot: string, name: string): void {
  try {
    getOrCreateAgentDb(agentRoot).run({
      sql: 'UPDATE config SET value = NULL WHERE name = ?',
      params: [name],
    });
  } catch {
    // DB not ready
  }
}

export function removeAgentConfig(agentRoot: string, name: string): void {
  try {
    getOrCreateAgentDb(agentRoot).run({
      sql: 'DELETE FROM config WHERE name = ?',
      params: [name],
    });
  } catch {
    // DB not ready or guard blocked
  }
}
