// Host-neutral file storage seam. The agent owns a tree of files identical on
// every host (Node daemon, Electron desktop, Cloudflare Durable Object); only
// the underlying store differs. All file IO in `shared/` goes through this
// interface so the Cloudflare port can swap node:fs (rooted at `runtimeRoot`)
// for an R2 bucket (per-agent key prefix) without touching the consumers.
//
// Paths are POSIX-style, relative to the agent root (e.g. `notes/todo.md`,
// `.agentwfy/sessions/123.json`). The store — not the caller — enforces the
// agent path policy: traversal outside the root is rejected, and the private
// `.agentwfy/` subtree is hidden unless `allowPrivate` is set. The Node impl
// resolves symlinks; key stores do prefix validation.

export interface FileStat {
  /** Size in bytes (0 for directories). */
  size: number
  /** Last-modified time in epoch ms. */
  mtimeMs: number
  isDirectory: boolean
}

/** One entry from a non-recursive directory listing, with its stat. */
export interface DirEntry {
  /** Base name, no path separators. */
  name: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

/** One node from a recursive walk; `path` is POSIX, relative to the root. */
export interface WalkEntry {
  path: string
  isDirectory: boolean
}

export interface PathOptions {
  /** Permit a path that does not exist (writes, mkdir, rename dest). */
  allowMissing?: boolean
  /** Permit access to the private `.agentwfy/` subtree (system code only). */
  allowPrivate?: boolean
}

export interface RemoveOptions extends PathOptions {
  /** Remove directories and their contents. */
  recursive?: boolean
  /** Don't throw if the target is already gone. */
  missingOk?: boolean
}

export interface MkdirOptions extends PathOptions {
  /** Create parent directories as needed (default true). */
  recursive?: boolean
}

export interface FileStore {
  /** Read raw bytes. Throws if the path is missing (unless allowMissing, in
   *  which case a missing file still throws — use `stat` to probe existence). */
  readBytes(path: string, opts?: PathOptions): Promise<Uint8Array>

  /** Read the whole file as UTF-8 text. Throws if missing. */
  readText(path: string, opts?: PathOptions): Promise<string>

  /** First `byteCount` bytes decoded as UTF-8 (best-effort). Returns '' when
   *  the path is missing or unreadable — never throws. */
  readHead(path: string, byteCount: number, opts?: PathOptions): Promise<string>

  /** Write raw bytes, creating parent directories as needed. */
  writeBytes(path: string, data: Uint8Array, opts?: PathOptions): Promise<void>

  /** Write UTF-8 text, creating parent directories as needed. */
  writeText(path: string, data: string, opts?: PathOptions): Promise<void>

  /** Append UTF-8 text, creating the file/parents if needed. */
  appendText(path: string, data: string, opts?: PathOptions): Promise<void>

  /** Stat a path; null when it does not exist. Policy violations still throw. */
  stat(path: string, opts?: PathOptions): Promise<FileStat | null>

  /** Non-recursive directory listing (with per-entry stat); [] when the
   *  directory is missing. Private entries are skipped unless allowPrivate. */
  list(path: string, opts?: PathOptions): Promise<DirEntry[]>

  /** Recursive listing of everything under `path` (files and directory
   *  markers), POSIX paths relative to the root. Private subtrees are skipped
   *  unless allowPrivate. Returns [] when the path is missing or not a dir. */
  walk(path: string, opts?: PathOptions): Promise<WalkEntry[]>

  /** Remove a file or directory. */
  remove(path: string, opts?: RemoveOptions): Promise<void>

  /** Move/rename a path, creating the destination's parents as needed. */
  rename(fromPath: string, toPath: string, opts?: PathOptions): Promise<void>

  /** Create a directory (recursive by default). No-op for key stores. */
  mkdir(path: string, opts?: MkdirOptions): Promise<void>
}
