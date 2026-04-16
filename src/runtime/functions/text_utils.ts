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

export function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line
  return line.slice(0, maxLen) + '\u2026'
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

export function paginateText(raw: string, offset?: number, limit?: number): string {
  const allLines = raw.split('\n')
  const totalLines = allLines.length
  const startLine = offset ? Math.max(0, offset - 1) : 0
  const startLineDisplay = startLine + 1

  if (startLine >= totalLines) {
    throw new Error(`Offset ${offset} is beyond end of content (${totalLines} lines total)`)
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

  const trunc = truncateHead(selectedContent, MAX_READ_LINES, MAX_READ_BYTES)

  if (trunc.firstLineExceedsLimit) {
    return `[Line ${startLineDisplay} is ${formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'))}, exceeds ${formatSize(MAX_READ_BYTES)} limit.]`
  }

  if (trunc.truncated) {
    const endLineDisplay = startLine + trunc.outputLines
    const nextOffset = endLineDisplay + 1
    if (trunc.truncatedBy === 'lines') {
      return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
    }
    return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(MAX_READ_BYTES)} limit). Use offset=${nextOffset} to continue.]`
  }

  if (userLimitedLines !== undefined && startLine + userLimitedLines < totalLines) {
    const remaining = totalLines - (startLine + userLimitedLines)
    const nextOffset = startLine + userLimitedLines + 1
    return trunc.content + `\n\n[${remaining} more lines. Use offset=${nextOffset} to continue.]`
  }

  return trunc.content
}
