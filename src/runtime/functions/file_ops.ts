import path from 'path'
import fs from 'fs/promises'
import { assertPathAllowed, isAgentPrivatePath } from '../../security/path-policy.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_READ_BINARY_BYTES = 20 * 1024 * 1024
const GREP_MAX_LINE_LENGTH = 500
const DEFAULT_GREP_LIMIT = 100
const DEFAULT_FIND_LIMIT = 1000
const DEFAULT_LS_LIMIT = 500

interface TruncationResult {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  outputLines: number
  firstLineExceedsLimit: boolean
}

function truncateHead(text: string, maxLines: number, maxBytes: number): TruncationResult {
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line
  return line.slice(0, maxLen) + '…'
}

async function walkDir(dir: string, root: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (isAgentPrivatePath(root, full)) continue
    const rel = path.relative(root, full)
    if (entry.isDirectory()) {
      results.push(rel + '/')
      results.push(...await walkDir(full, root))
    } else {
      results.push(rel)
    }
  }
  return results
}

function matchesGlob(filename: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`).test(filename)
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function registerFileOps(registry: FunctionRegistry, deps: { agentRoot: string }): void {
  const { agentRoot } = deps

  registry.register('read', async (params) => {
    const request = params as WorkerHostMethodMap['read']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('read requires a non-empty path string')
    }
    if (typeof request.offset !== 'undefined' && (!Number.isFinite(request.offset) || request.offset < 1)) {
      throw new Error('read offset must be a number >= 1 when provided')
    }
    if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
      throw new Error('read limit must be a number >= 1 when provided')
    }

    const filePath = await assertPathAllowed(agentRoot, request.path)

    // Auto-detect binary files by MIME type
    const mime = mimeFromPath(filePath)
    if (mime !== 'application/octet-stream' && !mime.startsWith('text/')) {
      const stat = await fs.stat(filePath)
      if (stat.size > MAX_READ_BINARY_BYTES) {
        throw new Error(`File too large (${stat.size} bytes). Max binary read size is ${MAX_READ_BINARY_BYTES} bytes.`)
      }
      const buffer = await fs.readFile(filePath)
      return {
        base64: buffer.toString('base64'),
        mimeType: mime,
        size: buffer.length,
      }
    }

    // Text file
    const raw = await fs.readFile(filePath, 'utf-8')
    const allLines = raw.split('\n')
    const totalFileLines = allLines.length

    const startLine = request.offset ? Math.max(0, request.offset - 1) : 0
    const startLineDisplay = startLine + 1
    if (startLine >= totalFileLines) {
      throw new Error(`Offset ${request.offset} is beyond end of file (${totalFileLines} lines total)`)
    }

    let selectedContent: string
    let userLimitedLines: number | undefined

    if (request.limit !== undefined) {
      const endLine = Math.min(startLine + request.limit, totalFileLines)
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
        return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
      }
      return trunc.content + `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(MAX_READ_BYTES)} limit). Use offset=${nextOffset} to continue.]`
    }

    if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
      const remaining = totalFileLines - (startLine + userLimitedLines)
      const nextOffset = startLine + userLimitedLines + 1
      return trunc.content + `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
    }

    return trunc.content
  })

  registry.register('write', async (params) => {
    const request = params as WorkerHostMethodMap['write']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('write requires a non-empty path string')
    }
    if (typeof request.content !== 'string') {
      throw new Error('write requires content as a string')
    }

    const filePath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, request.content, 'utf-8')
    return `Successfully wrote ${Buffer.byteLength(request.content, 'utf-8')} bytes to ${request.path}`
  })

  registry.register('writeBinary', async (params) => {
    const request = params as WorkerHostMethodMap['writeBinary']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('writeBinary requires a non-empty path string')
    }
    if (typeof request.base64 !== 'string') {
      throw new Error('writeBinary requires base64 as a string')
    }

    const filePath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const buffer = Buffer.from(request.base64, 'base64')
    await fs.writeFile(filePath, buffer)
    return `Successfully wrote ${buffer.length} bytes to ${request.path}`
  })

  registry.register('edit', async (params) => {
    const request = params as WorkerHostMethodMap['edit']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('edit requires a non-empty path string')
    }
    if (!Array.isArray(request.edits) || request.edits.length === 0) {
      throw new Error('edit requires edits array with at least one replacement')
    }

    const filePath = await assertPathAllowed(agentRoot, request.path)
    const rawContent = await fs.readFile(filePath, 'utf-8')

    // Strip BOM
    const bom = rawContent.startsWith('\uFEFF') ? '\uFEFF' : ''
    const content = bom ? rawContent.slice(1) : rawContent

    // Detect and normalize line endings
    const originalEnding = content.includes('\r\n') ? '\r\n' : '\n'
    const normalized = content.replace(/\r\n/g, '\n')

    // Find all edit positions in the original normalized content
    const positions: Array<{ start: number; end: number; newText: string }> = []

    for (const edit of request.edits) {
      if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
        throw new Error('Each edit must have oldText and newText strings')
      }
      const normalizedOld = edit.oldText.replace(/\r\n/g, '\n')
      const normalizedNew = edit.newText.replace(/\r\n/g, '\n')

      const idx = normalized.indexOf(normalizedOld)
      if (idx === -1) {
        throw new Error(`Could not find the exact text in ${request.path}. The old text must match exactly including all whitespace and newlines.`)
      }
      if (normalized.indexOf(normalizedOld, idx + normalizedOld.length) !== -1) {
        throw new Error(`Found multiple occurrences of the text in ${request.path}. Provide more context to make it unique.`)
      }

      positions.push({ start: idx, end: idx + normalizedOld.length, newText: normalizedNew })
    }

    // Sort by position and check for overlaps
    positions.sort((a, b) => a.start - b.start)
    for (let i = 1; i < positions.length; i++) {
      if (positions[i].start < positions[i - 1].end) {
        throw new Error(`Edits overlap in ${request.path}. Merge overlapping edits into one.`)
      }
    }

    // Apply in reverse order to preserve positions
    let result = normalized
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i]
      result = result.slice(0, p.start) + p.newText + result.slice(p.end)
    }

    // Restore original line endings and BOM
    if (originalEnding === '\r\n') {
      result = result.replace(/\n/g, '\r\n')
    }
    await fs.writeFile(filePath, bom + result, 'utf-8')
    return `Successfully replaced ${request.edits.length} block(s) in ${request.path}`
  })

  registry.register('ls', async (params) => {
    const request = (params ?? {}) as WorkerHostMethodMap['ls']['params']
    if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
      throw new Error('ls path must be a string when provided')
    }
    if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
      throw new Error('ls limit must be a number >= 1 when provided')
    }

    const root = await assertPathAllowed(agentRoot, '.', { allowMissing: true, allowAgentPrivate: true })
    const dirPath = await assertPathAllowed(agentRoot, request.path || '.')
    const effectiveLimit = request.limit ?? DEFAULT_LS_LIMIT

    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

    const results: string[] = []

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)
      if (isAgentPrivatePath(root, entryPath)) continue
      if (results.length >= effectiveLimit) break
      results.push(entry.isDirectory() ? entry.name + '/' : entry.name)
    }

    return results
  })

  registry.register('mkdir', async (params) => {
    const request = params as WorkerHostMethodMap['mkdir']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('mkdir requires a non-empty path string')
    }
    if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
      throw new Error('mkdir recursive must be a boolean when provided')
    }

    const dirPath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
    await fs.mkdir(dirPath, { recursive: request.recursive ?? true })
    return undefined
  })

  registry.register('remove', async (params) => {
    const request = params as WorkerHostMethodMap['remove']['params']
    if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('remove requires a non-empty path string')
    }
    if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
      throw new Error('remove recursive must be a boolean when provided')
    }

    const targetPath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
    await fs.rm(targetPath, { recursive: request.recursive ?? false, force: false })
    return undefined
  })

  registry.register('rename', async (params) => {
    const request = params as WorkerHostMethodMap['rename']['params']
    if (!request || typeof request.oldPath !== 'string' || request.oldPath.trim().length === 0) {
      throw new Error('rename requires a non-empty oldPath string')
    }
    if (typeof request.newPath !== 'string' || request.newPath.trim().length === 0) {
      throw new Error('rename requires a non-empty newPath string')
    }

    const srcPath = await assertPathAllowed(agentRoot, request.oldPath)
    const destPath = await assertPathAllowed(agentRoot, request.newPath, { allowMissing: true })
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.rename(srcPath, destPath)
    return `Renamed ${request.oldPath} → ${request.newPath}`
  })

  registry.register('find', async (params) => {
    const request = params as WorkerHostMethodMap['find']['params']
    if (!request || typeof request.pattern !== 'string' || request.pattern.trim().length === 0) {
      throw new Error('find requires a non-empty pattern string')
    }
    if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
      throw new Error('find path must be a string when provided')
    }
    if (typeof request.limit !== 'undefined' && (!Number.isFinite(request.limit) || request.limit < 1)) {
      throw new Error('find limit must be a number >= 1 when provided')
    }

    const root = await assertPathAllowed(agentRoot, '.', { allowMissing: true, allowAgentPrivate: true })
    const searchDir = request.path ? await assertPathAllowed(agentRoot, request.path, { allowMissing: true }) : root
    const effectiveLimit = request.limit ?? DEFAULT_FIND_LIMIT

    const all = await walkDir(searchDir, root)
    const matched = all.filter((p) => {
      const name = p.endsWith('/') ? p.slice(0, -1) : p
      return matchesGlob(name, request.pattern) || matchesGlob(path.basename(name), request.pattern)
    })

    if (matched.length === 0) return ''

    const limited = matched.slice(0, effectiveLimit)
    let output = limited.join('\n')

    if (matched.length > effectiveLimit) {
      output += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern.]`
    }

    return output
  })

  registry.register('grep', async (params) => {
    const request = params as WorkerHostMethodMap['grep']['params']
    if (!request || typeof request.pattern !== 'string' || request.pattern.trim().length === 0) {
      throw new Error('grep requires a non-empty pattern string')
    }
    if (typeof request.path !== 'undefined' && typeof request.path !== 'string') {
      throw new Error('grep path must be a string when provided')
    }
    if (typeof request.options !== 'undefined' && (request.options === null || typeof request.options !== 'object')) {
      throw new Error('grep options must be an object when provided')
    }

    const root = await assertPathAllowed(agentRoot, '.', { allowMissing: true, allowAgentPrivate: true })
    const searchPath = request.path ? await assertPathAllowed(agentRoot, request.path, { allowMissing: true }) : root
    const ignoreCase = request.options?.ignoreCase ?? false
    const literal = request.options?.literal ?? false
    const contextLines = request.options?.context ?? 0
    const effectiveLimit = request.options?.limit ?? DEFAULT_GREP_LIMIT

    let files: string[]
    const searchStat = await fs.stat(searchPath)
    if (searchStat.isFile()) {
      files = [path.relative(root, searchPath)]
    } else {
      files = await walkDir(searchPath, root)
    }
    const flags = ignoreCase ? 'i' : ''
    const escapedPattern = literal ? request.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : request.pattern
    const regex = new RegExp(escapedPattern, flags)

    const outputLines: string[] = []
    let matchCount = 0
    let limitReached = false

    for (const rel of files) {
      if (rel.endsWith('/')) continue
      if (limitReached) break
      const abs = path.join(root, rel)
      let content: string
      try {
        content = await fs.readFile(abs, 'utf-8')
      } catch {
        continue
      }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matchCount++
          if (matchCount > effectiveLimit) {
            limitReached = true
            break
          }

          const start = Math.max(0, i - contextLines)
          const end = Math.min(lines.length - 1, i + contextLines)

          if (outputLines.length > 0 && contextLines > 0) {
            outputLines.push('--')
          }

          for (let j = start; j <= end; j++) {
            const lineText = truncateLine(lines[j], GREP_MAX_LINE_LENGTH)
            if (j === i) {
              outputLines.push(`${rel}:${j + 1}: ${lineText}`)
            } else {
              outputLines.push(`${rel}-${j + 1}- ${lineText}`)
            }
          }
        }
      }
    }

    if (matchCount === 0) return ''

    let output = outputLines.join('\n')
    const notices: string[] = []

    if (limitReached) {
      notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
    }

    if (notices.length > 0) {
      output += `\n\n[${notices.join('. ')}]`
    }

    return output
  })
}
