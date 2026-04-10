import { storeGet } from '../ipc/store.js';
import { getOrCreateAgentDb } from '../db/agent-db.js';
import { globalConfigExists, globalConfigGet } from './global-config.js';
import type { OnDbChange } from '../db/sqlite.js';

function readAgentConfigValue(agentRoot: string, name: string): string | undefined {
  try {
    const rows = getOrCreateAgentDb(agentRoot).run({
      sql: 'SELECT value FROM config WHERE name = ?',
      params: [name],
    });
    if (rows.length === 0) return undefined;
    const row = rows[0] as Record<string, unknown>;
    if (row.value === null || row.value === undefined) return undefined;
    return String(row.value);
  } catch {
    return undefined;
  }
}

export function getGlobalValue(key: string): unknown {
  if (globalConfigExists()) return globalConfigGet(key);
  return storeGet(key);
}

export function getConfigValue(agentRoot: string, name: string, fallback?: unknown): unknown {
  const agentValue = readAgentConfigValue(agentRoot, name);
  if (agentValue !== undefined) return agentValue;

  const globalValue = getGlobalValue(name);
  if (globalValue !== undefined) return globalValue;

  return fallback;
}

export function setAgentConfig(agentRoot: string, name: string, value: unknown, onDbChange?: OnDbChange): void {
  const db = getOrCreateAgentDb(agentRoot);
  const strValue = String(value);
  // UPDATE first — works for all existing rows (including guarded system/plugin rows)
  db.run({ sql: 'UPDATE config SET value = ? WHERE name = ?', params: [strValue, name] }, onDbChange);
  // INSERT for new user rows — guard blocks this for system/plugin, but those already exist from sync
  try {
    db.run({ sql: 'INSERT INTO config (name, value) VALUES (?, ?)', params: [name, strValue] }, onDbChange);
  } catch {
    // Row already exists (UPDATE handled it) or guard blocked system/plugin INSERT
  }
}

export function clearAgentConfig(agentRoot: string, name: string, onDbChange?: OnDbChange): void {
  try {
    getOrCreateAgentDb(agentRoot).run({
      sql: 'UPDATE config SET value = NULL WHERE name = ?',
      params: [name],
    }, onDbChange);
  } catch {
    // DB not ready
  }
}

export function removeAgentConfig(agentRoot: string, name: string, onDbChange?: OnDbChange): void {
  try {
    getOrCreateAgentDb(agentRoot).run({
      sql: 'DELETE FROM config WHERE name = ?',
      params: [name],
    }, onDbChange);
  } catch {
    // DB not ready or guard blocked
  }
}
