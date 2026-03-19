import { utilityProcess, type BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type {
  ExecJsDetails,
  ExecJsLogEntry,
  ExecJsSerializedError,
  HostToWorkerMessage,
  WorkerHostCallMessage,
  WorkerHostMethod,
  WorkerHostMethodMap,
  WorkerToHostMessage,
  WorkerTabConsoleLogEntry,
} from './types.js'
import { assertPathAllowed, isAgentPrivatePath } from '../security/path-policy.js'
import { parseRunSqlRequest, routeSqlRequest } from '../db/sql-router.js'
import type { OnDbChange } from '../db/sqlite.js'
import type { AgentTabTools } from '../ipc/tabs.js'
import type { PluginRegistry } from '../plugins/registry.js'
import {
  truncateText,
  truncateLine,
  walkDir,
  matchesGlob,
  GREP_MAX_LINE_LENGTH,
  DEFAULT_GREP_LIMIT,
  DEFAULT_FIND_LIMIT,
  DEFAULT_LS_LIMIT,
} from '../ipc/files.js'
import { forwardBusPublish, forwardBusWaitFor, forwardSpawnAgent, forwardSendToAgent } from '../ipc/bus.js'
import { forwardStartTask, forwardStopTask } from '../task-runner/ipc.js'

const DEFAULT_EXEC_TIMEOUT_MS = 5000
const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024

type PendingExecution = {
  requestId: string
  resolve: (details: ExecJsDetails) => void
  reject: (error: unknown) => void
  cleanup?: () => void
  onLog?: (entry: ExecJsLogEntry) => void
}

type ChildEntry = {
  sessionId: string
  child: Electron.UtilityProcess
  pendingExecutions: Map<string, PendingExecution>
  onMessage: (message: WorkerToHostMessage) => void
  onExit: (code: number) => void
}

export interface JsRuntimeDeps {
  agentRoot: string
  win: BrowserWindow
  tabTools: AgentTabTools
  pluginRegistry: PluginRegistry | null
  onDbChange?: OnDbChange
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function serializeError(error: unknown): ExecJsSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    name: 'Error',
    message: String(error),
  }
}

function normalizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId is required for execJs worker execution')
  }

  return sessionId.trim()
}

export class JsRuntime {
  private readonly workers = new Map<string, ChildEntry>()
  private pluginMethods: string[] | null = null
  private readonly deps: JsRuntimeDeps

  constructor(deps: JsRuntimeDeps) {
    this.deps = deps
  }

  ensureWorker(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    if (this.workers.has(normalizedSessionId)) {
      return
    }

    const child = utilityProcess.fork(
      path.join(import.meta.dirname, 'exec_worker.js'),
      [],
      { serviceName: 'exec-worker-' + normalizedSessionId },
    )

    const entry: ChildEntry = {
      sessionId: normalizedSessionId,
      child,
      pendingExecutions: new Map(),
      onMessage: () => {},
      onExit: () => {},
    }

    entry.onMessage = (message: WorkerToHostMessage) => {
      this.handleWorkerMessage(entry, message)
    }

    entry.onExit = (code: number) => {
      const message = code === 0
        ? new Error(`Session worker exited for ${normalizedSessionId}`)
        : new Error(`Session worker crashed with code ${code} for ${normalizedSessionId}`)
      this.disposeEntry(entry, message)
    }

    child.on('message', entry.onMessage)
    child.on('exit', entry.onExit)

    this.workers.set(normalizedSessionId, entry)
  }

  terminateWorker(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      return
    }

    this.disposeEntry(entry, new Error(`Session worker terminated for ${normalizedSessionId}`))
  }

  async executeExecJs(
    sessionId: string,
    code: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    input?: unknown
  ): Promise<ExecJsDetails> {
    const normalizedSessionId = normalizeSessionId(sessionId)
    this.ensureWorker(normalizedSessionId)

    const entry = this.workers.get(normalizedSessionId)
    if (!entry) {
      throw new Error(`Failed to create session worker for ${normalizedSessionId}`)
    }

    // Lazy-load plugin method names
    if (this.pluginMethods === null) {
      try {
        const registry = this.deps.pluginRegistry
        this.pluginMethods = registry ? registry.getMethodNames() : []
      } catch (err) {
        console.warn('[plugins] Failed to load plugin methods:', err)
        this.pluginMethods = []
      }
    }

    const timeout = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
      ? Math.floor(timeoutMs as number)
      : DEFAULT_EXEC_TIMEOUT_MS

    if (signal?.aborted) {
      return {
        ok: false,
        error: {
          name: 'Error',
          message: 'JavaScript execution aborted',
        },
        logs: [],
        images: [],
        timeoutMs: timeout,
      }
    }

    const requestId = createId('exec-js')

    return new Promise<ExecJsDetails>((resolve, reject) => {
      const pending: PendingExecution = {
        requestId,
        resolve,
        reject,
      }

      if (signal) {
        const onAbort = () => {
          entry.child.postMessage({
            type: 'exec:cancel',
            requestId,
          } satisfies HostToWorkerMessage)
        }

        signal.addEventListener('abort', onAbort, { once: true })
        pending.cleanup = () => {
          signal.removeEventListener('abort', onAbort)
        }
      }

      entry.pendingExecutions.set(requestId, pending)

      entry.child.postMessage({
        type: 'exec:run',
        requestId,
        code,
        timeoutMs: timeout,
        input,
        pluginMethods: this.pluginMethods ?? undefined,
      } satisfies HostToWorkerMessage)
    })
  }

  cancelExecution(sessionId: string): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const entry = this.workers.get(normalizedSessionId)
    if (!entry) return

    // Cancel all pending executions
    for (const [, pending] of entry.pendingExecutions) {
      entry.child.postMessage({
        type: 'exec:cancel',
        requestId: pending.requestId,
      } satisfies HostToWorkerMessage)
    }
  }

  watchLogs(sessionId: string, onLog: (entry: ExecJsLogEntry) => void): void {
    this.setLogWatch(sessionId, onLog)
  }

  unwatchLogs(sessionId: string): void {
    this.setLogWatch(sessionId, undefined)
  }

  private setLogWatch(sessionId: string, onLog: ((entry: ExecJsLogEntry) => void) | undefined): void {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const entry = this.workers.get(normalizedSessionId)
    if (!entry) return

    const pending = entry.pendingExecutions.values().next().value
    if (!pending) return

    pending.onLog = onLog
    entry.child.postMessage({
      type: onLog ? 'exec:watch' : 'exec:unwatch',
      requestId: pending.requestId,
    } satisfies HostToWorkerMessage)
  }

  disposeAll(): void {
    for (const entry of this.workers.values()) {
      this.disposeEntry(entry, new Error(`Session worker disposed for ${entry.sessionId}`))
    }
  }

  private handleWorkerMessage(entry: ChildEntry, message: WorkerToHostMessage): void {
    if (!message || typeof message !== 'object' || typeof (message as unknown as Record<string, unknown>).type !== 'string') {
      return
    }

    switch (message.type) {
      case 'exec:result': {
        const pending = entry.pendingExecutions.get(message.requestId)
        if (!pending) {
          return
        }

        entry.pendingExecutions.delete(message.requestId)
        pending.cleanup?.()
        pending.resolve(message.details)
        return
      }
      case 'exec:log': {
        const pending = entry.pendingExecutions.get(message.requestId)
        if (pending?.onLog) {
          pending.onLog(message.logEntry)
        }
        return
      }
      case 'host:call': {
        void this.handleHostCall(entry, message)
        return
      }
      default:
        return
    }
  }

  private async handleHostCall(entry: ChildEntry, message: WorkerHostCallMessage): Promise<void> {
    try {
      const value = await this.invokeHostMethod(message.method, message.params)
      entry.child.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: true,
        value,
      } satisfies HostToWorkerMessage)
    } catch (error) {
      entry.child.postMessage({
        type: 'host:result',
        requestId: message.requestId,
        callId: message.callId,
        ok: false,
        error: serializeError(error),
      } satisfies HostToWorkerMessage)
    }
  }

  private async invokeHostMethod<M extends WorkerHostMethod>(
    method: M,
    params: unknown
  ): Promise<WorkerHostMethodMap[M]['result']> {
    const { agentRoot, win, tabTools, pluginRegistry } = this.deps

    switch (method) {
      case 'runSql': {
        const request = params as WorkerHostMethodMap['runSql']['params']
        if (!request || typeof request.sql !== 'string' || request.sql.trim().length === 0) {
          throw new Error('runSql requires a non-empty sql string')
        }

        const parsed = parseRunSqlRequest({
          target: request.target ?? 'agent',
          path: request.path,
          sql: request.sql,
          params: request.params,
          description: request.description,
        })
        const result = await routeSqlRequest(agentRoot, parsed, this.deps.onDbChange)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'read': {
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

        return output as WorkerHostMethodMap[M]['result']
      }
      case 'write': {
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
        return `Successfully wrote ${Buffer.byteLength(request.content, 'utf-8')} bytes to ${request.path}` as WorkerHostMethodMap[M]['result']
      }
      case 'writeBinary': {
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
        return `Successfully wrote ${buffer.length} bytes to ${request.path}` as WorkerHostMethodMap[M]['result']
      }
      case 'edit': {
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
        return `Successfully replaced text in ${request.path}` as WorkerHostMethodMap[M]['result']
      }
      case 'ls': {
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

        if (results.length === 0) return '(empty directory)' as WorkerHostMethodMap[M]['result']

        let output = results.join('\n')
        if (limitReached) {
          output += `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more.]`
        }
        return output as WorkerHostMethodMap[M]['result']
      }
      case 'mkdir': {
        const request = params as WorkerHostMethodMap['mkdir']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('mkdir requires a non-empty path string')
        }
        if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
          throw new Error('mkdir recursive must be a boolean when provided')
        }

        const dirPath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
        await fs.mkdir(dirPath, { recursive: request.recursive ?? true })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'remove': {
        const request = params as WorkerHostMethodMap['remove']['params']
        if (!request || typeof request.path !== 'string' || request.path.trim().length === 0) {
          throw new Error('remove requires a non-empty path string')
        }
        if (typeof request.recursive !== 'undefined' && typeof request.recursive !== 'boolean') {
          throw new Error('remove recursive must be a boolean when provided')
        }

        const targetPath = await assertPathAllowed(agentRoot, request.path, { allowMissing: true })
        await fs.rm(targetPath, { recursive: request.recursive ?? false, force: false })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'find': {
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

        if (matched.length === 0) return 'No files found matching pattern' as WorkerHostMethodMap[M]['result']

        const limited = matched.slice(0, effectiveLimit)
        let output = limited.join('\n')

        if (matched.length > effectiveLimit) {
          output += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern.]`
        }

        return output as WorkerHostMethodMap[M]['result']
      }
      case 'grep': {
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

        if (matchCount === 0) return 'No matches found' as WorkerHostMethodMap[M]['result']

        let output = outputLines.join('\n')
        const notices: string[] = []

        if (limitReached) {
          notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
        }

        if (notices.length > 0) {
          output += `\n\n[${notices.join('. ')}]`
        }

        return output as WorkerHostMethodMap[M]['result']
      }
      case 'getTabs': {
        return tabTools.getTabs() as Promise<WorkerHostMethodMap[M]['result']>
      }
      case 'openTab': {
        const request = params as WorkerHostMethodMap['openTab']['params']
        if (!request) {
          throw new Error('openTab requires a request object')
        }

        const hasViewId = typeof request.viewId === 'string' || typeof request.viewId === 'number'
        const hasFilePath = typeof request.filePath === 'string' && request.filePath.length > 0
        const hasUrl = typeof request.url === 'string' && request.url.length > 0
        const sourceCount = (hasViewId ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0)

        if (sourceCount !== 1) {
          throw new Error('openTab requires exactly one of viewId, filePath, or url')
        }

        await tabTools.openTab({
          viewId: hasViewId ? request.viewId : undefined,
          filePath: hasFilePath ? request.filePath : undefined,
          url: hasUrl ? request.url : undefined,
          title: request.title,
          hidden: request.hidden,
        })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'closeTab': {
        const request = params as WorkerHostMethodMap['closeTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('closeTab requires a tabId')
        }

        await tabTools.closeTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'selectTab': {
        const request = params as WorkerHostMethodMap['selectTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('selectTab requires a tabId')
        }

        await tabTools.selectTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'reloadTab': {
        const request = params as WorkerHostMethodMap['reloadTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('reloadTab requires a tabId')
        }

        await tabTools.reloadTab({ tabId: request.tabId })
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'captureTab': {
        const request = params as WorkerHostMethodMap['captureTab']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('captureTab requires a tabId')
        }

        return tabTools.captureTab({ tabId: request.tabId }) as Promise<WorkerHostMethodMap[M]['result']>
      }
      case 'getTabConsoleLogs': {
        const request = params as WorkerHostMethodMap['getTabConsoleLogs']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('getTabConsoleLogs requires a tabId')
        }

        const logs = await tabTools.getTabConsoleLogs({
          tabId: request.tabId,
          since: request.since,
          limit: request.limit,
        })
        return logs as WorkerTabConsoleLogEntry[] as WorkerHostMethodMap[M]['result']
      }
      case 'execTabJs': {
        const request = params as WorkerHostMethodMap['execTabJs']['params']
        if (!request || typeof request.tabId !== 'string' || !request.tabId.trim()) {
          throw new Error('execTabJs requires a tabId')
        }
        if (typeof request.code !== 'string') {
          throw new Error('execTabJs requires JavaScript code as a string')
        }

        const result = await tabTools.execTabJs({
          tabId: request.tabId,
          code: request.code,
          timeoutMs: request.timeoutMs,
        })
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'busPublish': {
        const request = params as WorkerHostMethodMap['busPublish']['params']
        if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
          throw new Error('busPublish requires a non-empty topic string')
        }
        forwardBusPublish(win, request.topic, request.data)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'busWaitFor': {
        const request = params as WorkerHostMethodMap['busWaitFor']['params']
        if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
          throw new Error('busWaitFor requires a non-empty topic string')
        }
        const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 120_000
        const result = await forwardBusWaitFor(win, request.topic, timeoutMs)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'spawnAgent': {
        const request = params as WorkerHostMethodMap['spawnAgent']['params']
        if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
          throw new Error('spawnAgent requires a non-empty prompt string')
        }
        const result = await forwardSpawnAgent(win, request.prompt)
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'sendToAgent': {
        const request = params as WorkerHostMethodMap['sendToAgent']['params']
        if (!request || typeof request.agentId !== 'string' || request.agentId.trim().length === 0) {
          throw new Error('sendToAgent requires a non-empty agentId string')
        }
        if (typeof request.message !== 'string' || request.message.trim().length === 0) {
          throw new Error('sendToAgent requires a non-empty message string')
        }
        await forwardSendToAgent(win, request.agentId, request.message)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      case 'startTask': {
        const request = params as WorkerHostMethodMap['startTask']['params']
        if (!request || typeof request.taskId !== 'number') {
          throw new Error('startTask requires a taskId number')
        }
        const result = await forwardStartTask(win, request.taskId, request.input, { type: 'agent' })
        return result as WorkerHostMethodMap[M]['result']
      }
      case 'stopTask': {
        const request = params as WorkerHostMethodMap['stopTask']['params']
        if (!request || typeof request.runId !== 'string' || request.runId.trim().length === 0) {
          throw new Error('stopTask requires a non-empty runId string')
        }
        await forwardStopTask(win, request.runId)
        return undefined as WorkerHostMethodMap[M]['result']
      }
      default: {
        const methodStr = String(method)
        if (methodStr.startsWith('plugin:')) {
          if (!pluginRegistry) {
            throw new Error('Plugin registry not available')
          }
          return await pluginRegistry.call(methodStr.slice(7), params) as WorkerHostMethodMap[M]['result']
        }
        throw new Error(`Unsupported worker host method: ${methodStr}`)
      }
    }
  }

  private disposeEntry(entry: ChildEntry, error: Error): void {
    if (!this.workers.has(entry.sessionId)) {
      return
    }

    this.workers.delete(entry.sessionId)

    entry.child.removeListener('message', entry.onMessage)
    entry.child.removeListener('exit', entry.onExit)

    for (const [, pending] of entry.pendingExecutions) {
      pending.cleanup?.()
      pending.reject(error)
    }

    entry.pendingExecutions.clear()

    entry.child.kill()
  }
}
