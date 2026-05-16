// FileSource — backend-agnostic facade for reading agent files served via
// the agentview:// protocol.
//
// - LocalFileSource serves directly from the on-disk cacheRoot (the agent's
//   own runtimeRoot, when the agent runs in-process).
// - RemoteFileSource fetches bytes through the AgentBackend's files API, so
//   the desktop can render files that live on the remote daemon without
//   maintaining a parallel filesystem mirror.

import { readFile } from 'fs/promises'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import { serveFile } from '#shared/protocol/file-server.js'
import type { AgentBackend } from '#shared/backend/interface.js'

export interface FileSource {
  /** Serve a file as an HTTP-style Response (for agentview://file/... raw serve). */
  serve(request: Request, relPath: string): Promise<Response>
  /** Read the file as UTF-8 text (for agentview://view/...?source=file). */
  readText(relPath: string): Promise<string>
}

export class LocalFileSource implements FileSource {
  constructor(private readonly cacheRoot: string) {}

  async serve(request: Request, relPath: string): Promise<Response> {
    const absolutePath = await assertPathAllowed(this.cacheRoot, relPath, { allowMissing: false })
    return serveFile(request, absolutePath)
  }

  async readText(relPath: string): Promise<string> {
    const absolutePath = await assertPathAllowed(this.cacheRoot, relPath, { allowMissing: false })
    return readFile(absolutePath, 'utf-8')
  }
}

function parseRangeHeader(header: string | null, size: number):
  | { ok: true; start: number; end: number; isRange: boolean }
  | { ok: false } {
  if (!header || !header.startsWith('bytes=')) {
    return { ok: true, start: 0, end: size - 1, isRange: false }
  }
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return { ok: false }
  const start = m[1] ? parseInt(m[1], 10) : 0
  const end = m[2] ? parseInt(m[2], 10) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false }
  if (start >= size || end >= size || start > end) return { ok: false }
  return { ok: true, start, end, isRange: true }
}

export class RemoteFileSource implements FileSource {
  constructor(private readonly backend: AgentBackend) {}

  async serve(request: Request, relPath: string): Promise<Response> {
    let first
    try {
      // First read probes the file size and gets the head of the requested
      // range; one round-trip is enough for files inside the daemon's per-read
      // cap, larger files stream on through pull().
      const rangeProbe = request.headers.get('Range')
      const probeOffset = parseProbeOffset(rangeProbe)
      first = await this.backend.files.read({ path: relPath, offset: probeOffset })
    } catch (err) {
      console.error('[agentview/remote-file] read failed:', err)
      return new Response('Not Found', { status: 404 })
    }

    const { size, content: firstChunk, mimeType, offset: firstOffset } = first
    const range = parseRangeHeader(request.headers.get('Range'), size)
    if (!range.ok) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
    const { start, end, isRange } = range

    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Content-Length': (end - start + 1).toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    if (isRange) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

    const backend = this.backend
    const firstChunkEnd = firstOffset + firstChunk.byteLength - 1
    let cursor = start
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (cursor > end) { controller.close(); return }
          if (cursor >= firstOffset && cursor <= firstChunkEnd) {
            const sliceStart = cursor - firstOffset
            const sliceEnd = Math.min(firstChunkEnd, end) - firstOffset + 1
            controller.enqueue(firstChunk.subarray(sliceStart, sliceEnd))
            cursor = firstOffset + sliceEnd
            if (cursor > end) controller.close()
            return
          }
          const { content } = await backend.files.read({
            path: relPath,
            offset: cursor,
            limit: end - cursor + 1,
          })
          if (content.byteLength === 0) { controller.close(); return }
          const take = Math.min(content.byteLength, end - cursor + 1)
          controller.enqueue(take === content.byteLength ? content : content.subarray(0, take))
          cursor += take
          if (cursor > end) controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    return new Response(body, { status: isRange ? 206 : 200, headers })
  }

  async readText(relPath: string): Promise<string> {
    const first = await this.backend.files.read({ path: relPath })
    if (first.content.byteLength >= first.size) {
      return new TextDecoder('utf-8').decode(first.content)
    }
    // Files larger than the daemon's per-read cap need additional rounds;
    // concatenate, then decode once so multi-byte sequences across chunk
    // boundaries aren't corrupted.
    const chunks: Uint8Array[] = [first.content]
    let cursor = first.offset + first.content.byteLength
    while (cursor < first.size) {
      const next = await this.backend.files.read({ path: relPath, offset: cursor })
      if (next.content.byteLength === 0) break
      chunks.push(next.content)
      cursor += next.content.byteLength
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.byteLength }
    return new TextDecoder('utf-8').decode(merged)
  }
}

function parseProbeOffset(header: string | null): number {
  if (!header || !header.startsWith('bytes=')) return 0
  const m = header.match(/^bytes=(\d*)-/)
  if (!m || !m[1]) return 0
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 0 ? n : 0
}
