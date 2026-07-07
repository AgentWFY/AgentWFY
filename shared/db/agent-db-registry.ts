// Host-neutral registry for AgentDb connections. Holds the
// `Map<key, AgentDb>` and the create/close/version/mirror helpers that the rest
// of `shared/` calls, but knows nothing about *how* an AgentDb is built — the
// host injects a factory + key-normalizer via `configureAgentDbRegistry`.
//
// - Node (`agent-db.ts`) installs a factory that builds an AgentDb over a
//   `NodeSqlDriver` (+ fs mkdir + bundled system JSON) and a `path.resolve`
//   normalizer, at module load.
// - A host with a single, eagerly-built connection can `registerAgentDb` it
//   directly, so `getOrCreateAgentDb` returns it without ever calling a factory.
//
// This file is node-free so a non-Node build can import the consumers
// (`sqlite.ts`, `settings/config.ts`, `db/tasks.ts`, the runtime functions)
// without dragging in `node:sqlite` / `node:fs`.

import type { AgentDb } from './agent-db-core.js';
import type { AgentDbChange } from './sql-types.js';

export type AgentDbFactory = (key: string) => AgentDb;
export type AgentDbKeyNormalizer = (dataDir: string) => string;

let factory: AgentDbFactory | null = null;
let normalizeKey: AgentDbKeyNormalizer = (dataDir) => dataDir;

const connections = new Map<string, AgentDb>();

/** Install the host's AgentDb factory + key-normalizer. Called once at module
 *  load by the host registry (Node), or skipped by a host that pre-registers
 *  its connection. */
export function configureAgentDbRegistry(opts: {
  factory: AgentDbFactory;
  normalizeKey?: AgentDbKeyNormalizer;
}): void {
  factory = opts.factory;
  if (opts.normalizeKey) normalizeKey = opts.normalizeKey;
}

export function getOrCreateAgentDb(dataDir: string): AgentDb {
  const key = normalizeKey(dataDir);
  const existing = connections.get(key);
  if (existing) return existing;

  if (!factory) {
    throw new Error(
      `AgentDb registry not configured: no connection registered for "${key}" and no factory installed`,
    );
  }
  const conn = factory(key);
  connections.set(key, conn);
  return conn;
}

/** Pre-register an already-built AgentDb (for a host that builds its one
 *  connection eagerly). */
export function registerAgentDb(dataDir: string, db: AgentDb): void {
  connections.set(normalizeKey(dataDir), db);
}

export function getRegisteredAgentDb(dataDir: string): AgentDb | undefined {
  return connections.get(normalizeKey(dataDir));
}

export function closeAgentDb(dataDir: string): void {
  const key = normalizeKey(dataDir);
  const conn = connections.get(key);
  if (conn) {
    conn.close();
    connections.delete(key);
  }
}

export function getAgentDbCurrentVersion(dataDir: string): number {
  return getOrCreateAgentDb(dataDir).getCurrentVersion();
}

export function applyAgentDbMirrorChange(dataDir: string, change: AgentDbChange): void {
  getOrCreateAgentDb(dataDir).applyMirrorChange(change);
}
