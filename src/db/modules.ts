import { runAgentDbSql } from './sqlite.js';

export interface ModuleRecord {
  name: string;
  type: string;
  content: string;
}

export async function getModuleContent(
  dataDir: string,
  name: string,
): Promise<ModuleRecord | null> {
  const rows = await runAgentDbSql(dataDir, {
    sql: 'SELECT name, type, content FROM modules WHERE name = ? LIMIT 1',
    params: [name],
  });

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0] as Record<string, unknown>;
  return {
    name: row.name as string,
    type: row.type as string,
    content: row.content as string,
  };
}
