export const MAX_READ_LINES = 2000
export const MAX_READ_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500
export const DEFAULT_GREP_LIMIT = 100
export const DEFAULT_FIND_LIMIT = 1000
export const DEFAULT_LS_LIMIT = 500

interface TruncationResult {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  outputLines: number
  firstLineExceedsLimit: boolean
}

export interface ReadTextOptions {
  offset?: number
  limit?: number
  full?: boolean
  maxBytes?: number
  ref?: string
}

export function truncateHead(text: string, maxLines: number, maxBytes: number): TruncationResult {
  const totalBytes = Buffer.byteLength(text, 'utf-8')
  const lines = text.split('\n')
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines, firstLineExceedsLimit: false }
  }

  const firstLineBytes = Buffer.byteLength(lines[0], 'utf-8')
  if (firstLineBytes > maxBytes) {
    return { content: '', truncated: true, truncatedBy: 'bytes', totalLines, outputLines: 0, firstLineExceedsLimit: true }
  }

  let byteCount = 0
  let lineCount = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + (i > 0 ? 1 : 0)
    if (byteCount + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    byteCount += lineBytes
    lineCount++
  }

  if (lineCount >= maxLines && byteCount <= maxBytes) {
    truncatedBy = 'lines'
  }

  return {
    content: lines.slice(0, lineCount).join('\n'),
    truncated: true,
    truncatedBy,
    totalLines,
    outputLines: lineCount,
    firstLineExceedsLimit: false,
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatLineCount(lines: number): string {
  return `${lines} line${lines === 1 ? '' : 's'}`
}

function readArgs(ref: string, extra: string): string {
  return extra
    ? `read({ path: ${JSON.stringify(ref)}, ${extra} })`
    : `read({ path: ${JSON.stringify(ref)} })`
}

function makeDefaultReadLimitError(
  ref: string,
  totalBytes: number,
  totalLines: number,
  maxBytes: number,
): Error {
  const reasons: string[] = []
  if (totalBytes > maxBytes) reasons.push(`${formatSize(totalBytes)} exceeds ${formatSize(maxBytes)}`)
  if (totalLines > MAX_READ_LINES) reasons.push(`${formatLineCount(totalLines)} exceeds ${formatLineCount(MAX_READ_LINES)}`)
  return new Error(
    `read: ${ref} is ${formatSize(totalBytes)} across ${formatLineCount(totalLines)}, ` +
    `which is above the default complete-read limit (${formatSize(maxBytes)} / ${formatLineCount(MAX_READ_LINES)}). ` +
    `Default ${readArgs(ref, '')} only succeeds when it can return the entire content. ` +
    `To intentionally read the whole file now, use ${readArgs(ref, 'full: true')}. ` +
    `To inspect it in chunks, use ${readArgs(ref, 'offset: 1')} and continue with the next offset shown; ` +
    `if a line itself is larger than the default cap, add maxBytes, e.g. ${readArgs(ref, `offset: 1, maxBytes: ${totalBytes}`)}. ` +
    `Why this failed: ${reasons.join('; ')}.`
  )
}

function makeFullReadMaxBytesError(
  ref: string,
  totalBytes: number,
  totalLines: number,
  maxBytes: number,
): Error {
  return new Error(
    `read: ${ref} is ${formatSize(totalBytes)} across ${formatLineCount(totalLines)}, ` +
    `which exceeds the explicit maxBytes=${maxBytes} (${formatSize(maxBytes)}) safety cap for full read. ` +
    `Increase the cap, e.g. ${readArgs(ref, `full: true, maxBytes: ${totalBytes}`)}, ` +
    `or read in chunks with ${readArgs(ref, 'offset: 1')}.`
  )
}

export function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line
  return line.slice(0, maxLen) + '\u2026'
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function makeSnippet(text: string, matchIndex: number, matchLength: number, contextChars = 80): string {
  const start = Math.max(0, matchIndex - contextChars)
  const end = Math.min(text.length, matchIndex + matchLength + contextChars)
  let out = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) out = '…' + out
  if (end < text.length) out = out + '…'
  return out
}

export function compileGlob(pattern: string): RegExp {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`)
}

export function matchesGlob(filename: string, pattern: string): boolean {
  return compileGlob(pattern).test(filename)
}

export function applyTextEdits(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
  ref: string,
): string {
  const positions: Array<{ start: number; end: number; newText: string }> = []

  for (const edit of edits) {
    const idx = content.indexOf(edit.oldText)
    if (idx === -1) {
      throw new Error(`Could not find the exact text in ${ref}. The old text must match exactly including all whitespace and newlines.`)
    }
    if (content.indexOf(edit.oldText, idx + edit.oldText.length) !== -1) {
      throw new Error(`Found multiple occurrences of the text in ${ref}. Provide more context to make it unique.`)
    }
    positions.push({ start: idx, end: idx + edit.oldText.length, newText: edit.newText })
  }

  positions.sort((a, b) => a.start - b.start)
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].start < positions[i - 1].end) {
      throw new Error(`Edits overlap in ${ref}. Merge overlapping edits into one.`)
    }
  }

  let result = content
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i]
    result = result.slice(0, p.start) + p.newText + result.slice(p.end)
  }
  return result
}

export function paginateText(raw: string, options: ReadTextOptions = {}): string {
  const { offset, limit, full = false } = options
  const ref = options.ref ?? 'content'
  const maxBytes = Math.floor(options.maxBytes ?? MAX_READ_BYTES)
  const allLines = raw.split('\n')
  const totalLines = allLines.length
  const totalBytes = Buffer.byteLength(raw, 'utf-8')
  const startLine = offset ? Math.max(0, offset - 1) : 0
  const startLineDisplay = startLine + 1

  if (full) {
    if (offset !== undefined || limit !== undefined) {
      throw new Error(
        `read: ${ref} requested full: true together with offset/limit. ` +
        `Use ${readArgs(ref, 'full: true')} for the entire content, or ${readArgs(ref, 'offset: 1')} for chunked reading.`
      )
    }
    if (options.maxBytes !== undefined && totalBytes > maxBytes) {
      throw makeFullReadMaxBytesError(ref, totalBytes, totalLines, maxBytes)
    }
    return raw
  }

  const explicitChunk = offset !== undefined || limit !== undefined
  if (!explicitChunk && (totalBytes > maxBytes || totalLines > MAX_READ_LINES)) {
    throw makeDefaultReadLimitError(ref, totalBytes, totalLines, maxBytes)
  }

  if (startLine >= totalLines) {
    throw new Error(`read: offset ${offset} is beyond end of ${ref} (${formatLineCount(totalLines)} total)`)
  }

  let selectedContent: string
  let userLimitedLines: number | undefined

  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, totalLines)
    selectedContent = allLines.slice(startLine, endLine).join('\n')
    userLimitedLines = endLine - startLine
  } else {
    selectedContent = allLines.slice(startLine).join('\n')
  }

  const maxLines = limit !== undefined ? Math.floor(limit) : MAX_READ_LINES
  const trunc = truncateHead(selectedContent, maxLines, maxBytes)

  if (trunc.firstLineExceedsLimit) {
    const lineBytes = Buffer.byteLength(allLines[startLine], 'utf-8')
    throw new Error(
      `read: line ${startLineDisplay} in ${ref} is ${formatSize(lineBytes)}, ` +
      `which exceeds maxBytes=${maxBytes} (${formatSize(maxBytes)}). ` +
      `Use ${readArgs(ref, 'full: true')} to read the whole content, ` +
      `or retry this chunk with ${readArgs(ref, `offset: ${startLineDisplay}, maxBytes: ${lineBytes}`)}.`
    )
  }

  if (trunc.truncated) {
    const endLineDisplay = startLine + trunc.outputLines
    const nextOffset = endLineDisplay + 1
    if (trunc.truncatedBy === 'lines') {
      return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
    }
    return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(maxBytes)} limit). Use offset=${nextOffset} to continue.]`
  }

  if (userLimitedLines !== undefined && startLine + userLimitedLines < totalLines) {
    const remaining = totalLines - (startLine + userLimitedLines)
    const nextOffset = startLine + userLimitedLines + 1
    return trunc.content + `\n\n[${remaining} more lines. Use offset=${nextOffset} to continue.]`
  }

  return trunc.content
}
