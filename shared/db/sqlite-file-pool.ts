// Host side of the `sqlite-file` worker thread. Owns the worker's lifecycle
// and turns postMessage traffic into promises.
//
// See `sqlite_file_worker.mts` for why this work is off the host thread at all.

import { Worker } from 'node:worker_threads'
import path from 'node:path'
import type {
  SqliteFileWorkerError,
  SqliteFileWorkerRequest,
  SqliteFileWorkerResponse,
} from './sqlite-file-protocol.js'

/** Terminate the worker after this long with nothing to do, releasing its open
 *  database handles and page caches. Respawning costs a few milliseconds and is
 *  only paid by the next query. Mirrors `JsRuntime`'s exec-worker eviction. */
const IDLE_EVICT_MS = 5 * 60 * 1000

interface Pending {
  resolve: (rows: unknown[]) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, Pending>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function workerEntry(): string {
  // Compiled alongside this module: dist/shared/db/sqlite_file_worker.mjs
  return path.join(import.meta.dirname, 'sqlite_file_worker.mjs')
}

function rejectAll(error: Error): void {
  const inFlight = Array.from(pending.values())
  pending.clear()
  for (const entry of inFlight) entry.reject(error)
}

/** Drop the current worker so the next request spawns a fresh one. */
function retire(current: Worker | null): void {
  if (current && worker !== current) return
  worker = null
  clearIdleTimer()
}

function clearIdleTimer(): void {
  if (idleTimer === null) return
  clearTimeout(idleTimer)
  idleTimer = null
}

function armIdleTimer(): void {
  clearIdleTimer()
  if (!worker) return
  const timer = setTimeout(() => {
    idleTimer = null
    // A request may have arrived between the timer firing and this callback.
    if (pending.size > 0) {
      armIdleTimer()
      return
    }
    const stale = worker
    worker = null
    void stale?.terminate()
  }, IDLE_EVICT_MS)
  // Buffered idle state must never hold a shutting-down process open.
  timer.unref?.()
  idleTimer = timer
}

function ensureWorker(): Worker {
  if (worker) return worker

  const spawned = new Worker(workerEntry())

  spawned.on('message', (response: SqliteFileWorkerResponse) => {
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)

    if (response.ok) {
      entry.resolve(response.rows)
    } else {
      entry.reject(reviveError(response.error))
    }

    if (pending.size === 0) {
      // Nothing in flight — stop holding the event loop open, start the clock.
      spawned.unref()
      armIdleTimer()
    }
  })

  spawned.on('error', (error: Error) => {
    retire(spawned)
    rejectAll(error)
  })

  spawned.on('exit', (code) => {
    retire(spawned)
    if (pending.size > 0) {
      rejectAll(new Error(`sqlite-file worker exited unexpectedly (code ${code})`))
    }
  })

  spawned.unref()
  worker = spawned
  return spawned
}

function reviveError(serialized: SqliteFileWorkerError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  if (serialized.stack) error.stack = serialized.stack
  if (serialized.code) (error as { code?: string }).code = serialized.code
  return error
}

/** Run one query against an already-resolved `.sqlite` file path. */
export function runOnSqliteFileWorker(
  dbPath: string,
  sql: string,
  params: unknown[] | undefined,
): Promise<unknown[]> {
  const active = ensureWorker()
  clearIdleTimer()
  // Hold the event loop open while a query is outstanding, so the host can't
  // exit out from under an in-flight request.
  active.ref()

  const id = nextRequestId++
  const request: SqliteFileWorkerRequest = { id, path: dbPath, sql, params }

  return new Promise<unknown[]>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    active.postMessage(request)
  })
}

/** Shut the worker down. Exposed for host teardown and tests. */
export async function disposeSqliteFileWorker(): Promise<void> {
  const active = worker
  worker = null
  clearIdleTimer()
  rejectAll(new Error('sqlite-file worker disposed'))
  if (active) await active.terminate()
}
