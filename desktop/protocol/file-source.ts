// FileSource — backend-agnostic facade for reading agent files served from
// /file/... and file-sourced /view/... routes.
//
// - LocalFileSource serves directly from the on-disk cacheRoot (the agent's
//   own runtimeRoot, when the agent runs in-process).
// - RemoteFileSource issues a 302 to a short-lived signed daemon URL for
//   browser-driven static fetches (`<img>`, `<video>`, etc.) so bytes flow
//   over plain HTTP instead of base64-over-WS. The agent runtime still uses
//   `backend.files.read` over the WS — see readText below.

import { readFile } from 'fs/promises'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import { serveFile } from '#shared/protocol/file-server.js'
import type { AgentBackend } from '#shared/backend/interface.js'
import { signFileUrl } from '#shared/backend/signed-urls.js'

export interface FileSource {
  /** Serve a file as an HTTP-style Response (for /file/... raw serve). */
  serve(request: Request, relPath: string): Promise<Response>
  /** Read the file as UTF-8 text (for /view/...?source=file). */
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

export interface RemoteFileSourceConfig {
  agentId: string
  daemonBaseUrl: string
  agentToken: string
}

export class RemoteFileSource implements FileSource {
  constructor(
    private readonly backend: AgentBackend,
    private readonly config: RemoteFileSourceConfig,
  ) {}

  async serve(_request: Request, relPath: string): Promise<Response> {
    // The redirect itself isn't cached; the signed target carries its own
    // Cache-Control so the browser caches the file until the signature
    // expires, then refetches via a fresh redirect.
    const location = signFileUrl({
      daemonBaseUrl: this.config.daemonBaseUrl,
      agentId: this.config.agentId,
      token: this.config.agentToken,
      path: relPath,
    })
    return new Response(null, {
      status: 302,
      headers: {
        Location: location,
        'Cache-Control': 'no-store',
      },
    })
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
