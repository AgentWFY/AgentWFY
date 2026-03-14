import { runAgentDbSql } from './sqlite.js';

export interface TaskCatalogRecord {
  id: number;
  name: string;
  description: string;
  timeout_ms: number | null;
  updated_at: number;
}

function asObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') {
    throw new Error('Invalid task row returned from agent DB');
  }
  return row as Record<string, unknown>;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Invalid "${fieldName}" in agent DB task row`);
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Invalid "${fieldName}" in agent DB task row`);
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function toCatalogRecord(row: unknown): TaskCatalogRecord {
  const record = asObject(row);
  return {
    id: asNumber(record.id, 'id'),
    name: asString(record.name, 'name'),
    description: typeof record.description === 'string' ? record.description : '',
    timeout_ms: asNullableNumber(record.timeout_ms),
    updated_at: asNumber(record.updated_at, 'updated_at'),
  };
}

export async function listTasks(dataDir: string): Promise<TaskCatalogRecord[]> {
  const rows = await runAgentDbSql(dataDir, {
    sql: 'SELECT id, name, description, timeout_ms, updated_at FROM tasks ORDER BY updated_at DESC',
  });

  return rows.map((row) => toCatalogRecord(row));
}
