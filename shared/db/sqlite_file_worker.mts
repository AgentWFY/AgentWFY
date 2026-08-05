// Worker thread that executes the `sqlite-file` runSql target.
//
// Why a thread: node:sqlite's `DatabaseSync` blocks for the whole query, and
// the `sqlite-file` target points at arbitrary user data files — a candles DB
// with millions of rows, not the agent's own small DB. A single unlucky query
// plan (a many-term OR predicate plus ORDER BY makes SQLite abandon the OR
// index optimization and scan the table) runs for seconds. Executed on the
// Electron main process that froze the entire window, input included.
//
// The host resolves and security-checks the path before sending it here, so
// this file never sees a raw agent-supplied path — see `sqlite-file.ts`.
//
// Requests are handled one at a time, in arrival order. That was already true
// when they ran on the main thread; the difference is that the UI no longer
// waits with them.

import { parentPort } from 'node:worker_threads'
import { NodeSqlDriver } from './node-sql-driver.js'
import { normalizeSqlRows, normalizeParams } from './sql-types.js'
import type { SqlParam } from './sql-driver.js'
import type {
  SqliteFileWorkerError,
  SqliteFileWorkerRequest,
  SqliteFileWorkerResponse,
} from './sqlite-file-protocol.js'

/** Open connections to keep around. Each holds a SQLite page cache, which is
 *  the whole point — a fresh connection re-reads B-tree pages on every call
 *  (0.43 ms vs 0.002 ms for a point lookup on a 92 MB file). Bounded so a run
 *  that touches hundreds of symbol files doesn't hold them all open. */
const MAX_OPEN_DBS = 8

const port = parentPort
if (!port) {
  throw new Error('sqlite_file_worker must be started as a worker thread')
}

/** Insertion-ordered, so the first key is the least recently used. */
const drivers = new Map<string, NodeSqlDriver>()

function acquire(dbPath: string): NodeSqlDriver {
  const existing = drivers.get(dbPath)
  if (existing) {
    // Re-insert to mark as most recently used.
    drivers.delete(dbPath)
    drivers.set(dbPath, existing)
    return existing
  }

  const driver = new NodeSqlDriver(dbPath)
  // Applied once per connection rather than once per call — it is connection
  // state, and re-running it on every query was pure overhead.
  driver.execBatch('PRAGMA foreign_keys = ON;')
  drivers.set(dbPath, driver)

  while (drivers.size > MAX_OPEN_DBS) {
    const oldest = drivers.keys().next()
    if (oldest.done) break
    drivers.get(oldest.value)?.close()
    drivers.delete(oldest.value)
  }

  return driver
}

/** Drop a connection whose query threw. The error may have left the handle in
 *  a state we can't reason about (a half-applied statement, a file replaced on
 *  disk), and reopening costs a fraction of a millisecond. */
function discard(dbPath: string): void {
  const driver = drivers.get(dbPath)
  if (!driver) return
  drivers.delete(dbPath)
  try {
    driver.close()
  } catch {
    // Already closed, or closing threw — nothing useful to do either way.
  }
}

port.on('message', (request: SqliteFileWorkerRequest) => {
  let response: SqliteFileWorkerResponse
  try {
    const params = normalizeParams(request.params) as SqlParam[]
    const rows = acquire(request.path).query(request.sql, params)
    // Normalizing here keeps the walk (33 ms on a 45k-row result) off the host.
    response = { id: request.id, ok: true, rows: normalizeSqlRows(rows) }
  } catch (error) {
    discard(request.path)
    response = { id: request.id, ok: false, error: serializeError(error) }
  }
  port.postMessage(response)
})

function serializeError(error: unknown): SqliteFileWorkerError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(typeof code === 'string' ? { code } : {}),
    }
  }
  return { name: 'Error', message: String(error) }
}
