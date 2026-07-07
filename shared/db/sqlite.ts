// Node-free entry point for agent-DB SQL. `runAgentDbSql` runs a request
// against the agent's own DB via the host-neutral registry; the actual driver
// (e.g. NodeSqlDriver) is whatever the host installed. SQL against an
// arbitrary on-disk `.sqlite` *file* (the `sqlite-file` runSql target) is
// Node-only and lives in `sqlite-file.ts` so it doesn't leak `node:sqlite`
// into this module's importers (the runtime functions, config, views, …).

import { getOrCreateAgentDb } from './agent-db-registry.js';
import type { SqlExecutionRequest } from './sql-types.js';

export { isPotentiallyMutatingSql } from './sql-introspect.js';
export { normalizeSqlRows, normalizeParams } from './sql-types.js';
export type { SqlExecutionRequest, AgentDbChange } from './sql-types.js';

export async function runAgentDbSql(dataDir: string, request: SqlExecutionRequest): Promise<unknown[]> {
  return getOrCreateAgentDb(dataDir).run(request);
}
