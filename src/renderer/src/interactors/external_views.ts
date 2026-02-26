export type ExternalViewId = string | number

export interface ViewCatalogEntry {
  title: string
  viewId: ExternalViewId
  viewUpdatedAt?: number | null
}

interface AgentViewCatalogRow {
  id: ExternalViewId
  name: string
  updated_at?: number | string | null
}

export async function loadViewCatalog(_cacheBust?: string): Promise<ViewCatalogEntry[]> {
  const tools = window.electronAgentTools
  if (!tools?.runSql) {
    console.error('Failed to load view catalog: window.electronAgentTools.runSql is not available')
    return []
  }

  let rows: unknown
  try {
    rows = await tools.runSql({
      target: 'agent',
      sql: 'SELECT id, name, updated_at FROM views ORDER BY updated_at DESC',
      description: 'Load external view catalog from agent DB',
    })
  } catch (e) {
    console.error('Failed to load DB view catalog:', e)
    return []
  }

  if (!Array.isArray(rows)) {
    console.error('Failed to load DB view catalog: expected an array result')
    return []
  }

  const entries: ViewCatalogEntry[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const typedRow = row as Partial<AgentViewCatalogRow>
    if (typeof typedRow.name !== 'string') continue
    if (typeof typedRow.id !== 'number' && typeof typedRow.id !== 'string') continue

    entries.push({
      title: typedRow.name,
      viewId: typedRow.id,
      viewUpdatedAt: normalizeOptionalNumber(typedRow.updated_at),
    })
  }

  return entries
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}
