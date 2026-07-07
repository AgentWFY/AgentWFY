// Node host registry for AgentDb. Installs the AgentDb *factory* into the
// host-neutral registry (`agent-db-registry.ts`) — building the AgentDb over a
// `NodeSqlDriver`, reading the bundled system docs/views/config JSON, and
// owning the fs-bound snapshot-file I/O. The connection cache + create/close/
// version/mirror helpers live in the registry; this file just teaches it how
// to make a Node connection and re-exports the registry API so the ~11 callers
// are unchanged. Importing this module (which every Node host does) installs
// the factory as a side effect.
//
// A non-Node host skips this file entirely and `registerAgentDb`s its own
// driver-backed AgentDb on the registry.

import path from 'path';
import fs from 'fs';
import { NodeSqlDriver } from './node-sql-driver.js';
import { createAgentDb } from './agent-db-core.js';
import type { SystemData, AgentDbSnapshotResult } from './agent-db-core.js';
import { configureAgentDbRegistry, getOrCreateAgentDb, closeAgentDb } from './agent-db-registry.js';

export { AgentDb, createAgentDb, isReplicatedTable } from './agent-db-core.js';
export type { SystemData, AgentDbSnapshotResult } from './agent-db-core.js';
export {
  getOrCreateAgentDb,
  registerAgentDb,
  closeAgentDb,
  getAgentDbCurrentVersion,
  applyAgentDbMirrorChange,
} from './agent-db-registry.js';

/** Read the bundled system docs/views/config JSON shipped alongside `dist/shared`. */
function readSystemData(): SystemData {
  const dir = path.join(import.meta.dirname, '..');
  const read = <T>(file: string): T => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as T;
  return {
    docs: read('system-docs.json'),
    views: read('system-views.json'),
    config: read('system-config.json'),
  };
}

const connectionOptions = new Map<string, { syncSystemData?: boolean }>();

export function configureAgentDb(dataDir: string, opts: { syncSystemData?: boolean }): void {
  const key = path.resolve(dataDir);
  connectionOptions.set(key, opts);
}

export function getAgentDbPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), '.agentwfy', 'agent.db');
}

// Install the Node AgentDb factory + path-resolving key normalizer. `key` is
// already `path.resolve`d by the registry before it reaches the factory.
configureAgentDbRegistry({
  normalizeKey: (dataDir) => path.resolve(dataDir),
  factory: (key) => {
    const agentDir = path.join(key, '.agentwfy');
    fs.mkdirSync(agentDir, { recursive: true });
    const opts = connectionOptions.get(key) ?? {};
    return createAgentDb({
      sql: new NodeSqlDriver(getAgentDbPath(key)),
      systemData: opts.syncSystemData === false ? null : readSystemData(),
    });
  },
});

export async function writeAgentDbSnapshotFile(
  dataDir: string,
  snapshotPath: string,
): Promise<AgentDbSnapshotResult> {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.rmSync(snapshotPath, { force: true });
  return getOrCreateAgentDb(dataDir).writeSnapshotFile(snapshotPath);
}

export function replaceAgentDbSnapshotFile(dataDir: string, snapshotPath: string): void {
  const key = path.resolve(dataDir);
  closeAgentDb(key);
  const agentDbPath = getAgentDbPath(key);
  fs.mkdirSync(path.dirname(agentDbPath), { recursive: true });
  const tmpPath = `${agentDbPath}.${process.pid}.${Date.now()}.tmp`;
  fs.renameSync(snapshotPath, tmpPath);
  fs.renameSync(tmpPath, agentDbPath);
  fs.rmSync(`${agentDbPath}-wal`, { force: true });
  fs.rmSync(`${agentDbPath}-shm`, { force: true });
}
