import { runAgentDbSql } from './sqlite.js';

export interface ConfigRecord {
  name: string;
  value: string | null;
  description: string;
}

export async function listConfig(dataDir: string): Promise<ConfigRecord[]> {
  const rows = await runAgentDbSql(dataDir, {
    sql: `SELECT name, value, description FROM config
      ORDER BY
        CASE
          WHEN name NOT LIKE 'system.%' AND name NOT LIKE 'plugin.%' THEN 0
          WHEN name LIKE 'system.%' THEN 1
          WHEN name LIKE 'plugin.%' THEN 2
        END, name`,
  });

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      name: r.name as string,
      value: r.value as string | null,
      description: (r.description as string) ?? '',
    };
  });
}
