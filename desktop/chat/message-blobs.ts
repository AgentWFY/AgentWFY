// Out-of-band delivery for the binary blocks that ride on chat messages.
//
// `execJs` results embed screenshots directly as `{type:'file', data:<base64>}`
// blocks, and those blocks sit in the streaming message and in the transcript
// for the rest of the session. Sent inline, one screenshot means a
// multi-megabyte structured clone on every snapshot and on every streaming
// frame. Instead the main process keeps the base64 here and hands the renderer
// an `app://blob/<id>` URL (served by the `app` protocol handler in main.ts).
//
// Ids are content hashes, so a URL's bytes never change and the renderer can
// cache them forever — a re-sent transcript costs nothing after the first fetch.
//
// Memory: the strings kept here are the *same* string objects the live
// DisplayMessage holds, so a loaded session retains nothing extra. Only blobs
// belonging to disposed sessions add anything, and the LRU cap bounds that.
// Every push re-registers the displayed transcript's blobs, which refreshes
// their recency — so eviction always reaches off-screen blobs first.

import { createHash } from 'node:crypto'
import type { Block, DisplayMessage } from '#shared/agent/provider_types.js'

interface BlobEntry {
  mimeType: string
  /** base64, shared with the DisplayMessage block it came from. */
  data: string
}

/** URL host reserved for blobs. `app://blob/<id>`. */
export const BLOB_HOST = 'blob'

/** Cap on retained base64 characters. Evicts least-recently-used past this. */
const MAX_BLOB_CHARS = 256 * 1024 * 1024

/** Under this, an extra round trip costs more than inlining the bytes. */
const MIN_BLOB_CHARS = 4096

/** Insertion-ordered, so the first key is the least recently used. */
const blobs = new Map<string, BlobEntry>()
let blobChars = 0

/** File block → blob id, so the hash is computed once per block rather than
 *  once per frame. Keyed on identity; file blocks are never mutated. */
const idByBlock = new WeakMap<object, string>()

function touch(id: string, entry: BlobEntry): void {
  blobs.delete(id)
  blobs.set(id, entry)
}

function store(id: string, mimeType: string, data: string): void {
  const existing = blobs.get(id)
  if (existing) {
    touch(id, existing)
    return
  }
  blobs.set(id, { mimeType, data })
  blobChars += data.length
  while (blobChars > MAX_BLOB_CHARS && blobs.size > 1) {
    const oldest = blobs.keys().next()
    if (oldest.done) break
    const evicted = blobs.get(oldest.value)
    blobs.delete(oldest.value)
    if (evicted) blobChars -= evicted.data.length
  }
}

/** Look up a blob for the protocol handler, refreshing its recency. */
export function readBlob(id: string): BlobEntry | null {
  const entry = blobs.get(id)
  if (!entry) return null
  touch(id, entry)
  return entry
}

type FileLike = { type: 'file'; mimeType: string; data: string; url?: string }

function externalizeFile<T extends FileLike>(file: T): T {
  if (file.url || file.data.length < MIN_BLOB_CHARS) return file
  let id = idByBlock.get(file)
  if (id === undefined) {
    id = createHash('sha256').update(file.data).digest('hex').slice(0, 32)
    idByBlock.set(file, id)
  }
  store(id, file.mimeType, file.data)
  return { ...file, data: '', url: `app://${BLOB_HOST}/${id}` }
}

/** Replace inline binaries in one block with blob URLs. Returns the block
 *  itself when there is nothing to move, so callers can detect "unchanged". */
export function externalizeBlock(block: Block): Block {
  if (block.type === 'file') return externalizeFile(block)
  if (block.type !== 'exec_js_result') return block

  let changed = false
  const content = block.content.map((item) => {
    if (item.type !== 'file') return item
    const next = externalizeFile(item)
    if (next !== item) changed = true
    return next
  })
  return changed ? { ...block, content } : block
}

export function externalizeMessage<T extends DisplayMessage | null>(msg: T): T {
  if (!msg) return msg
  let changed = false
  const blocks = msg.blocks.map((b) => {
    const next = externalizeBlock(b)
    if (next !== b) changed = true
    return next
  })
  return (changed ? { ...msg, blocks } : msg) as T
}

/** Returns the same array when no message carried a binary, so the pump's
 *  transcript-identity check keeps working. */
export function externalizeMessages(msgs: DisplayMessage[]): DisplayMessage[] {
  let changed = false
  const out = msgs.map((m) => {
    const next = externalizeMessage(m)
    if (next !== m) changed = true
    return next
  })
  return changed ? out : msgs
}
