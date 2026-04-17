import { runAgentDbSql } from '../../db/sqlite.js'
import { paginateText, applyTextEdits, truncateLine, GREP_MAX_LINE_LENGTH, DEFAULT_LS_LIMIT, DEFAULT_FIND_LIMIT, DEFAULT_GREP_LIMIT } from './text_utils.js'

export interface DbPath {
  table: string
  name?: string
}

const VALID_TABLES = new Set(['views', 'modules', 'tasks', 'docs'])

export function parseDbPath(p: string): DbPath | null {
  if (!p.startsWith('@')) return null
  const rest = p.slice(1).replace(/\/$/, '')
  if (!rest) return { table: '' }
  const slash = rest.indexOf('/')
  if (slash === -1) {
    if (!VALID_TABLES.has(rest)) {
      throw new Error(`Unknown DB table '@${rest}'. Valid: ${[...VALID_TABLES].sort().join(', ')}`)
    }
    return { table: rest }
  }
  const table = rest.slice(0, slash)
  const name = rest.slice(slash + 1)
  if (!VALID_TABLES.has(table)) {
    throw new Error(`Unknown DB table '@${table}'. Valid: ${[...VALID_TABLES].sort().join(', ')}`)
  }
  return name ? { table, name } : { table }
}

function requireName(dbPath: DbPath, op: string): string {
  if (!dbPath.name) {
    throw new Error(`${op} requires a specific row: @${dbPath.table}/<name>`)
  }
  return dbPath.name
}

// --- read ---

export async function dbRead(
  agentRoot: string,
  dbPath: DbPath,
  offset?: number,
  limit?: number,
): Promise<string> {
  const name = requireName(dbPath, 'read')
  const rows = await runAgentDbSql(agentRoot, {
    sql: `SELECT content FROM ${dbPath.table} WHERE name = ?`,
    params: [name],
  })
  if (rows.length === 0) {
    throw new Error(`Not found: @${dbPath.table}/${name}`)
  }
  return paginateText((rows[0] as Record<string, unknown>).content as string, offset, limit)
}

// --- write ---

const UPSERT_SQL: Record<string, { sql: string; params: (name: string, content: string) => (string | null)[] }> = {
  views: {
    sql: `INSERT INTO views (name, title, content) VALUES (?, '', ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
    params: (name, content) => [name, content],
  },
  modules: {
    sql: `INSERT INTO modules (name, content) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
    params: (name, content) => [name, content],
  },
  tasks: {
    sql: `INSERT INTO tasks (name, title, content) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
    params: (name, content) => [name, name, content],
  },
  docs: {
    sql: `INSERT INTO docs (name, content) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content`,
    params: (name, content) => [name, content],
  },
}

export async function dbWrite(agentRoot: string, dbPath: DbPath, content: string): Promise<string> {
  const name = requireName(dbPath, 'write')
  if (dbPath.table === 'modules' && !/\.(js|css)$/.test(name)) {
    throw new Error(`Module name must end with .js or .css: @modules/${name}`)
  }
  const spec = UPSERT_SQL[dbPath.table]
  await runAgentDbSql(agentRoot, {
    sql: spec.sql,
    params: spec.params(name, content),
  })
  return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to @${dbPath.table}/${name}`
}

// --- edit ---

export async function dbEdit(
  agentRoot: string,
  dbPath: DbPath,
  edits: Array<{ oldText: string; newText: string }>,
): Promise<string> {
  const name = requireName(dbPath, 'edit')
  const ref = `@${dbPath.table}/${name}`
  const rows = await runAgentDbSql(agentRoot, {
    sql: `SELECT content FROM ${dbPath.table} WHERE name = ?`,
    params: [name],
  })
  if (rows.length === 0) {
    throw new Error(`Not found: ${ref}`)
  }

  const content = applyTextEdits((rows[0] as Record<string, unknown>).content as string, edits, ref)

  await runAgentDbSql(agentRoot, {
    sql: `UPDATE ${dbPath.table} SET content = ? WHERE name = ?`,
    params: [content, name],
  })

  return `Successfully replaced ${edits.length} block(s) in ${ref}`
}

// --- ls ---

export async function dbLs(agentRoot: string, dbPath: DbPath, limit?: number): Promise<string[]> {
  if (!dbPath.table) {
    return [...VALID_TABLES].sort().map(t => t + '/')
  }
  const effectiveLimit = limit ?? DEFAULT_LS_LIMIT
  const rows = await runAgentDbSql(agentRoot, {
    sql: `SELECT name FROM ${dbPath.table} ORDER BY name LIMIT ?`,
    params: [effectiveLimit],
  })
  return rows.map(r => (r as Record<string, unknown>).name as string)
}

// --- find ---

export async function dbFind(
  agentRoot: string,
  dbPath: DbPath,
  pattern: string,
  limit?: number,
): Promise<string> {
  if (!dbPath.table) {
    throw new Error('find requires a table: @views, @modules, @tasks, or @docs')
  }
  const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT
  // Normalize ** to * for SQL GLOB (DB names have no slashes, so they're equivalent)
  const sqlGlob = pattern.replace(/\*\*/g, '*')
  const rows = await runAgentDbSql(agentRoot, {
    sql: `SELECT name FROM ${dbPath.table} WHERE name GLOB ? ORDER BY name LIMIT ?`,
    params: [sqlGlob, effectiveLimit + 1],
  })
  if (rows.length === 0) return ''
  const names = rows.map(r => (r as Record<string, unknown>).name as string)
  const limited = names.slice(0, effectiveLimit)
  let output = limited.map(n => `@${dbPath.table}/${n}`).join('\n')
  if (names.length > effectiveLimit) {
    output += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern.]`
  }
  return output
}

// --- grep ---

export async function dbGrep(
  agentRoot: string,
  dbPath: DbPath,
  pattern: string,
  options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
): Promise<string> {
  if (!dbPath.table) {
    throw new Error('grep requires a table: @views, @modules, @tasks, or @docs')
  }

  const ignoreCase = options?.ignoreCase ?? false
  const literal = options?.literal ?? false
  const contextLines = options?.context ?? 0
  const effectiveLimit = options?.limit ?? DEFAULT_GREP_LIMIT

  let contentRows: unknown[]
  if (dbPath.name) {
    contentRows = await runAgentDbSql(agentRoot, {
      sql: `SELECT name, content FROM ${dbPath.table} WHERE name = ?`,
      params: [dbPath.name],
    })
    if (contentRows.length === 0) {
      throw new Error(`Not found: @${dbPath.table}/${dbPath.name}`)
    }
  } else {
    contentRows = await runAgentDbSql(agentRoot, {
      sql: `SELECT name, content FROM ${dbPath.table} ORDER BY name`,
      params: [],
    })
  }

  const flags = ignoreCase ? 'i' : ''
  const escapedPattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
  const regex = new RegExp(escapedPattern, flags)

  const outputLines: string[] = []
  let matchCount = 0
  let limitReached = false

  for (const row of contentRows) {
    if (limitReached) break
    const r = row as Record<string, unknown>
    const name = r.name as string
    const content = r.content as string
    const lines = content.split('\n')
    const ref = `@${dbPath.table}/${name}`

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matchCount++
        if (matchCount > effectiveLimit) {
          limitReached = true
          break
        }
        const start = Math.max(0, i - contextLines)
        const end = Math.min(lines.length - 1, i + contextLines)
        if (outputLines.length > 0 && contextLines > 0) outputLines.push('--')
        for (let j = start; j <= end; j++) {
          const lineText = truncateLine(lines[j], GREP_MAX_LINE_LENGTH)
          if (j === i) {
            outputLines.push(`${ref}:${j + 1}: ${lineText}`)
          } else {
            outputLines.push(`${ref}-${j + 1}- ${lineText}`)
          }
        }
      }
    }
  }

  if (matchCount === 0) return ''
  let output = outputLines.join('\n')
  if (limitReached) {
    output += `\n\n[${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern]`
  }
  return output
}

// --- remove ---

export async function dbRemove(agentRoot: string, dbPath: DbPath): Promise<void> {
  const name = requireName(dbPath, 'remove')
  const rows = await runAgentDbSql(agentRoot, {
    sql: `DELETE FROM ${dbPath.table} WHERE name = ? RETURNING name`,
    params: [name],
  })
  if (rows.length === 0) {
    throw new Error(`Not found: @${dbPath.table}/${name}`)
  }
}

// --- rename ---

export async function dbRename(
  agentRoot: string,
  oldDbPath: DbPath,
  newDbPath: DbPath,
): Promise<string> {
  const oldName = requireName(oldDbPath, 'rename')
  const newName = requireName(newDbPath, 'rename')
  if (oldDbPath.table !== newDbPath.table) {
    throw new Error(`Cannot rename across tables: @${oldDbPath.table} \u2192 @${newDbPath.table}`)
  }
  const rows = await runAgentDbSql(agentRoot, {
    sql: `UPDATE ${oldDbPath.table} SET name = ? WHERE name = ? RETURNING name`,
    params: [newName, oldName],
  })
  if (rows.length === 0) {
    throw new Error(`Not found: @${oldDbPath.table}/${oldName}`)
  }
  return `Renamed @${oldDbPath.table}/${oldName} \u2192 @${newDbPath.table}/${newName}`
}
