// Bytes-level file access for the FilesApi.
//
// Reads run against the agent's `runtimeRoot`. Path sandboxing reuses the
// same `assertPathAllowed` policy as the runtime function registry, so this
// API can't be used to escape the agent dir.

import fs from 'fs/promises'
import { assertPathAllowed } from '../security/path-policy.js'
import { mimeFromPath } from '../runtime/mime.js'
import type { FilesReadResult, FilesStatResult } from './interface.js'

const MAX_READ_BYTES = 20 * 1024 * 1024

export async function readAgentFile(
  runtimeRoot: string,
  relativePath: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<FilesReadResult> {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    throw new Error('files.read requires a non-empty path string')
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const limit = Math.max(1, Math.floor(opts.limit ?? MAX_READ_BYTES))
  if (limit > MAX_READ_BYTES) {
    throw new Error(`files.read limit cannot exceed ${MAX_READ_BYTES} bytes`)
  }

  const absolutePath = await assertPathAllowed(runtimeRoot, relativePath, { allowMissing: false })
  const handle = await fs.open(absolutePath, 'r')
  try {
    const stat = await handle.stat()
    const remaining = Math.max(0, stat.size - offset)
    const toRead = Math.min(remaining, limit)
    // allocUnsafe is safe because we slice to bytesRead — uninitialized
    // tail bytes from a short read never reach the caller.
    const buf = Buffer.allocUnsafe(toRead)
    let bytesRead = 0
    if (toRead > 0) {
      const result = await handle.read(buf, 0, toRead, offset)
      bytesRead = result.bytesRead
    }
    return {
      size: stat.size,
      offset,
      content: bytesRead === buf.byteLength ? buf : buf.subarray(0, bytesRead),
      mimeType: mimeFromPath(absolutePath),
    }
  } finally {
    await handle.close()
  }
}

export async function statAgentFile(
  runtimeRoot: string,
  relativePath: string,
): Promise<FilesStatResult> {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    throw new Error('files.stat requires a non-empty path string')
  }
  const absolutePath = await assertPathAllowed(runtimeRoot, relativePath, { allowMissing: true })
  try {
    const stat = await fs.stat(absolutePath)
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false, size: 0, mtimeMs: 0 }
    }
    throw err
  }
}
