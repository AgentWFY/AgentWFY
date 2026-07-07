// Node implementation of FileStore: a real filesystem rooted at `runtimeRoot`.
// This is the only place node:fs touches the agent file tree in `shared/`.
// The agent path policy (no escape outside the root, private `.agentwfy/`
// hidden) is enforced by `assertPathAllowed`, which also resolves symlinks.

import fs from 'node:fs/promises'
import path from 'node:path'
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy.js'
import type {
  DirEntry,
  FileStat,
  FileStore,
  MkdirOptions,
  PathOptions,
  RemoveOptions,
  WalkEntry,
} from './file-store.js'

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

export class NodeFileStore implements FileStore {
  private readonly root: string
  /** Realpath of the root, used as the basis for private-subtree checks so a
   *  symlinked root resolves the same way `assertPathAllowed` does. Cached. */
  private realRootCache: Promise<string> | null = null

  constructor(root: string) {
    this.root = root
  }

  private resolve(p: string, opts?: PathOptions): Promise<string> {
    return assertPathAllowed(this.root, p, {
      allowMissing: opts?.allowMissing ?? false,
      allowAgentPrivate: opts?.allowPrivate ?? false,
    })
  }

  private realRoot(): Promise<string> {
    if (!this.realRootCache) {
      this.realRootCache = assertPathAllowed(this.root, '.', {
        allowMissing: true,
        allowAgentPrivate: true,
      })
    }
    return this.realRootCache
  }

  async readBytes(p: string, opts?: PathOptions): Promise<Uint8Array> {
    const abs = await this.resolve(p, opts)
    return fs.readFile(abs)
  }

  async readText(p: string, opts?: PathOptions): Promise<string> {
    const abs = await this.resolve(p, opts)
    return fs.readFile(abs, 'utf-8')
  }

  async readHead(p: string, byteCount: number, opts?: PathOptions): Promise<string> {
    let abs: string
    try {
      abs = await this.resolve(p, { allowMissing: true, ...opts })
    } catch {
      return ''
    }
    let handle: fs.FileHandle | null = null
    try {
      handle = await fs.open(abs, 'r')
      const buffer = Buffer.alloc(byteCount)
      const { bytesRead } = await handle.read(buffer, 0, byteCount, 0)
      return buffer.subarray(0, bytesRead).toString('utf-8')
    } catch {
      return ''
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
  }

  async writeBytes(p: string, data: Uint8Array, opts?: PathOptions): Promise<void> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, data)
  }

  async writeText(p: string, data: string, opts?: PathOptions): Promise<void> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, data, 'utf-8')
  }

  async appendText(p: string, data: string, opts?: PathOptions): Promise<void> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.appendFile(abs, data, 'utf-8')
  }

  async stat(p: string, opts?: PathOptions): Promise<FileStat | null> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    try {
      const s = await fs.stat(abs)
      return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }
    } catch (err) {
      if (isENOENT(err)) return null
      throw err
    }
  }

  async list(p: string, opts?: PathOptions): Promise<DirEntry[]> {
    const allowPrivate = opts?.allowPrivate ?? false
    const realRoot = await this.realRoot()
    const abs = await this.resolve(p || '.', { allowMissing: true, ...opts })

    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch (err) {
      if (isENOENT(err)) return []
      throw err
    }

    const out: DirEntry[] = []
    for (const entry of entries) {
      const full = path.join(abs, entry.name)
      if (!allowPrivate && isAgentPrivatePath(realRoot, full)) continue
      let size = 0
      let mtimeMs = 0
      try {
        const s = await fs.stat(full)
        size = s.size
        mtimeMs = s.mtimeMs
      } catch {
        // best-effort; entry may have vanished mid-listing
      }
      out.push({ name: entry.name, isDirectory: entry.isDirectory(), size, mtimeMs })
    }
    return out
  }

  async walk(p: string, opts?: PathOptions): Promise<WalkEntry[]> {
    const allowPrivate = opts?.allowPrivate ?? false
    const realRoot = await this.realRoot()
    const startAbs = await this.resolve(p || '.', { allowMissing: true, ...opts })

    const out: WalkEntry[] = []
    const recurse = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (!allowPrivate && isAgentPrivatePath(realRoot, full)) continue
        const rel = toPosix(path.relative(realRoot, full))
        if (entry.isDirectory()) {
          out.push({ path: rel, isDirectory: true })
          await recurse(full)
        } else {
          out.push({ path: rel, isDirectory: false })
        }
      }
    }
    await recurse(startAbs)
    return out
  }

  async remove(p: string, opts?: RemoveOptions): Promise<void> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    await fs.rm(abs, { recursive: opts?.recursive ?? false, force: opts?.missingOk ?? false })
  }

  async rename(fromPath: string, toPath: string, opts?: PathOptions): Promise<void> {
    const src = await this.resolve(fromPath, opts)
    const dest = await this.resolve(toPath, { allowMissing: true, ...opts })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(src, dest)
  }

  async mkdir(p: string, opts?: MkdirOptions): Promise<void> {
    const abs = await this.resolve(p, { allowMissing: true, ...opts })
    await fs.mkdir(abs, { recursive: opts?.recursive ?? true })
  }
}
