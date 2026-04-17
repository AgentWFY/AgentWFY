import { runAgentDbSql } from './sqlite.js';

export interface ModuleRecord {
  name: string;
  content: string;
}

export function getModuleContentType(name: string): string {
  return name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
}

export async function getModuleContent(
  dataDir: string,
  name: string,
): Promise<ModuleRecord | null> {
  const rows = await runAgentDbSql(dataDir, {
    sql: 'SELECT name, content FROM modules WHERE name = ? LIMIT 1',
    params: [name],
  });

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0] as Record<string, unknown>;
  return {
    name: row.name as string,
    content: row.content as string,
  };
}
