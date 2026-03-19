import path from 'path'
import fs from 'fs/promises'
import { assertPathAllowed, isAgentPrivatePath } from '../../security/path-policy.js'
import {
  truncateText,
  truncateLine,
  walkDir,
  matchesGlob,
  GREP_MAX_LINE_LENGTH,
  DEFAULT_GREP_LIMIT,
  DEFAULT_FIND_LIMIT,
  DEFAULT_LS_LIMIT,
} from '../../ipc/files.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024

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
    const raw = await fs.readFile(filePath, 'utf-8')
    const allLines = raw.split('\n')
    const totalLines = allLines.length

    const startLine = request.offset ? Math.max(0, request.offset - 1) : 0
    if (startLine >= totalLines) {
      throw new Error(`Offset ${request.offset} is beyond end of file (${totalLines} lines total)`)
    }

    const effectiveLimit = request.limit ?? MAX_READ_LINES
    const endLine = Math.min(startLine + effectiveLimit, totalLines)
    const selected = allLines.slice(startLine, endLine).join('\n')

    const trunc = truncateText(selected, effectiveLimit, MAX_READ_BYTES)
    const actualEnd = startLine + trunc.shownLines

    let output = trunc.content

    if (trunc.truncated || actualEnd < totalLines) {
      const nextOffset = actualEnd + 1
      output += `\n\n[Showing lines ${startLine + 1}-${actualEnd} of ${totalLines}. Use offset=${nextOffset} to continue.]`
    }

    return output
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
    if (typeof request.oldText !== 'string') {
      throw new Error('edit requires oldText as a string')
    }
    if (typeof request.newText !== 'string') {
      throw new Error('edit requires newText as a string')
    }

    const filePath = await assertPathAllowed(agentRoot, request.path)
    const content = await fs.readFile(filePath, 'utf-8')
    const occurrences = content.split(request.oldText).length - 1
    if (occurrences === 0) {
      throw new Error(`Could not find the exact text in ${request.path}. The old text must match exactly including all whitespace and newlines.`)
    }
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of the text in ${request.path}. The text must be unique. Provide more context to make it unique.`)
    }
    const updated = content.replace(request.oldText, request.newText)
    await fs.writeFile(filePath, updated, 'utf-8')
    return `Successfully replaced text in ${request.path}`
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
    let limitReached = false

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name)
      if (isAgentPrivatePath(root, entryPath)) continue
      if (results.length >= effectiveLimit) {
        limitReached = true
        break
      }
      results.push(entry.isDirectory() ? entry.name + '/' : entry.name)
    }

    if (results.length === 0) return '(empty directory)'

    let output = results.join('\n')
    if (limitReached) {
      output += `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more.]`
    }
    return output
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

    if (matched.length === 0) return 'No files found matching pattern'

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
    const searchDir = request.path ? await assertPathAllowed(agentRoot, request.path, { allowMissing: true }) : root
    const ignoreCase = request.options?.ignoreCase ?? false
    const literal = request.options?.literal ?? false
    const contextLines = request.options?.context ?? 0
    const effectiveLimit = request.options?.limit ?? DEFAULT_GREP_LIMIT

    const files = await walkDir(searchDir, root)
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

    if (matchCount === 0) return 'No matches found'

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
