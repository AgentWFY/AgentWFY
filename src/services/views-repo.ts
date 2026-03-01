import { runAgentDbSql } from './agent-db';

export interface ViewCatalogRecord {
  id: number;
  name: string;
  updated_at: number;
}

export interface ViewRecord extends ViewCatalogRecord {
  content: string;
  created_at: number;
}

function asObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') {
    throw new Error('Invalid view row returned from agent DB');
  }
  return row as Record<string, unknown>;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Invalid "${fieldName}" in agent DB view row`);
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

  throw new Error(`Invalid "${fieldName}" in agent DB view row`);
}

function toCatalogRecord(row: unknown): ViewCatalogRecord {
  const record = asObject(row);
  return {
    id: asNumber(record.id, 'id'),
    name: asString(record.name, 'name'),
    updated_at: asNumber(record.updated_at, 'updated_at'),
  };
}

function toViewRecord(row: unknown): ViewRecord {
  const record = asObject(row);
  return {
    id: asNumber(record.id, 'id'),
    name: asString(record.name, 'name'),
    content: asString(record.content, 'content'),
    created_at: asNumber(record.created_at, 'created_at'),
    updated_at: asNumber(record.updated_at, 'updated_at'),
  };
}

export async function ensureViewsSchema(dataDir: string): Promise<void> {
  await runAgentDbSql(dataDir, {
    sql: 'SELECT 1 FROM views LIMIT 1',
  });
}

export async function listViews(dataDir: string): Promise<ViewCatalogRecord[]> {
  const rows = await runAgentDbSql(dataDir, {
    sql: 'SELECT id, name, updated_at FROM views ORDER BY updated_at DESC',
  });

  return rows.map((row) => toCatalogRecord(row));
}

export async function getViewById(
  dataDir: string,
  viewId: number | string
): Promise<ViewRecord | null> {
  const rows = await runAgentDbSql(dataDir, {
    sql: 'SELECT id, name, content, created_at, updated_at FROM views WHERE id = ? LIMIT 1',
    params: [viewId],
  });

  if (rows.length === 0) {
    return null;
  }

  return toViewRecord(rows[0]);
}
