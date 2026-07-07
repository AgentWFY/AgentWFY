import { getOrCreateAgentDb } from '../db/agent-db-registry.js';

// Host-injected reader for the user-wide `~/.agentwfy.json` global config.
// Node installs it from the fs-bound `global-config.ts` (see node host wiring
// in `local_runtime.ts`); a host without a filesystem can leave it unset, so
// config there resolves purely from the agent DB (no `~/.agentwfy.json`).
interface GlobalConfigProvider {
  exists(): boolean;
  get(key: string): unknown;
}
let globalConfigProvider: GlobalConfigProvider | null = null;

export function configureGlobalConfigProvider(provider: GlobalConfigProvider): void {
  globalConfigProvider = provider;
}

// Fallback reader for the Electron-specific internal store (userData/config.json).
// The main process wires this at startup; the daemon leaves it as a no-op since
// it has no Electron userData path. When neither agent DB nor global config has
// a key, this is the last resort.
let fallbackStoreReader: (key: string) => unknown = () => undefined;

export function setFallbackStoreReader(reader: (key: string) => unknown): void {
  fallbackStoreReader = reader;
}

function readAgentConfigValue(runtimeRoot: string, name: string): string | undefined {
  try {
    const rows = getOrCreateAgentDb(runtimeRoot).run({
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
  if (globalConfigProvider?.exists()) return globalConfigProvider.get(key);
  return fallbackStoreReader(key);
}

export function getConfigValue(runtimeRoot: string, name: string, fallback?: unknown): unknown {
  const agentValue = readAgentConfigValue(runtimeRoot, name);
  if (agentValue !== undefined) return agentValue;

  const globalValue = getGlobalValue(name);
  if (globalValue !== undefined) return globalValue;

  return fallback;
}

export function setAgentConfig(runtimeRoot: string, name: string, value: unknown): void {
  const db = getOrCreateAgentDb(runtimeRoot);
  const strValue = String(value);
  // UPDATE first — works for all existing rows (including guarded system/plugin rows)
  db.run({ sql: 'UPDATE config SET value = ? WHERE name = ?', params: [strValue, name] });
  // INSERT for new user rows — guard blocks this for system/plugin, but those already exist from sync
  try {
    db.run({ sql: 'INSERT INTO config (name, value) VALUES (?, ?)', params: [name, strValue] });
  } catch {
    // Row already exists (UPDATE handled it) or guard blocked system/plugin INSERT
  }
}

export function clearAgentConfig(runtimeRoot: string, name: string): void {
  try {
    getOrCreateAgentDb(runtimeRoot).run({
      sql: 'UPDATE config SET value = NULL WHERE name = ?',
      params: [name],
    });
  } catch {
    // DB not ready
  }
}

export function removeAgentConfig(runtimeRoot: string, name: string): void {
  try {
    getOrCreateAgentDb(runtimeRoot).run({
      sql: 'DELETE FROM config WHERE name = ?',
      params: [name],
    });
  } catch {
    // DB not ready or guard blocked
  }
}
