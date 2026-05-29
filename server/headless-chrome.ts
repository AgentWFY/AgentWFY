import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getViewContent } from '#shared/db/views.js'
import { buildViewDocument } from '#shared/protocol/view-document.js'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import type {
  BrowserCdpSubscription,
  BrowserHost,
  BrowserOpenRequest,
  BrowserPageHandle,
  TabConsoleLog,
  TabData,
  TabDebuggerBufferedEvent,
  TabDebuggerPollResult,
  Viewport,
} from '#shared/runtime/hosts.js'
import {
  resolveHeadlessCloseAfterIdleMs,
  type HeadlessCloseAfterIdleMs,
} from '#shared/runtime/hosts.js'
import { CdpClient, type CdpEvent } from '#shared/browser/cdp-client.js'

const SUBSCRIPTION_BUFFER_MAX = 1000
const POLL_MAX_WAIT_MS = 60_000

interface HeadlessChromeBrowserHostOptions {
  runtimeRoot: string
}

interface PageRecord {
  tabId: string
  targetId: string
  sessionId: string
  viewport: Viewport
  type: 'view' | 'file' | 'url'
  target: string
  title: string
  params?: Record<string, string>
  logs: TabConsoleLog[]
  openedAt: number
  lastUsedAt: number
  closeAfterIdleMs: HeadlessCloseAfterIdleMs
  expiresAt: number | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

export async function createHeadlessChromeBrowserHostFromEnv(
  options: HeadlessChromeBrowserHostOptions,
): Promise<HeadlessChromeBrowserHost | null> {
  const cdpUrl = process.env['AGENTWFY_BROWSER_CDP_URL']
  const executable = process.env['AGENTWFY_BROWSER_EXECUTABLE']
  if (cdpUrl && cdpUrl.trim()) {
    return HeadlessChromeBrowserHost.connect(await resolveBrowserWebSocketUrl(cdpUrl.trim()), options)
  }
  if (executable && executable.trim()) {
    return launchHeadlessChrome(executable.trim(), options)
  }
  return null
}

async function launchHeadlessChrome(
  executable: string,
  options: HeadlessChromeBrowserHostOptions,
): Promise<HeadlessChromeBrowserHost> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentwfy-chrome-'))
  const child = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome refuses to start as root (Docker/CI) without --no-sandbox. This is
    // a locally-spawned headless helper the daemon fully controls, so the
    // sandbox buys nothing here.
    '--no-sandbox',
    '--disable-gpu',
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.warn(`[headless-chrome] ${text}`)
  })

  try {
    const wsUrl = await waitForDevToolsUrl(userDataDir)
    const host = await HeadlessChromeBrowserHost.connect(wsUrl, options, child, userDataDir)
    return host
  } catch (err) {
    child.kill()
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function waitForDevToolsUrl(userDataDir: string): Promise<string> {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 10_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf-8')
      const [port, wsPath] = text.trim().split('\n')
      if (port && wsPath) {
        return `ws://127.0.0.1:${port}${wsPath}`
      }
    } catch (err) {
      lastError = err
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for Chrome DevToolsActivePort: ${String(lastError)}`)
}

async function resolveBrowserWebSocketUrl(input: string): Promise<string> {
  if (input.startsWith('ws://') || input.startsWith('wss://')) return input
  const base = input.replace(/\/$/, '')
  const response = await fetch(`${base}/json/version`)
  if (!response.ok) {
    throw new Error(`Failed to query Chrome CDP endpoint ${base}/json/version: ${response.status}`)
  }
  const data = await response.json() as { webSocketDebuggerUrl?: unknown }
  if (typeof data.webSocketDebuggerUrl !== 'string' || !data.webSocketDebuggerUrl) {
    throw new Error('Chrome CDP /json/version did not return webSocketDebuggerUrl')
  }
  return data.webSocketDebuggerUrl
}

export class HeadlessChromeBrowserHost implements BrowserHost {
  private readonly pages = new Map<string, PageRecord>()
  private readonly client: CdpClient
  private readonly runtimeRoot: string
  private readonly child: ChildProcess | null
  private readonly userDataDir: string | null

  private constructor(
    client: CdpClient,
    options: HeadlessChromeBrowserHostOptions,
    child?: ChildProcess,
    userDataDir?: string,
  ) {
    this.client = client
    this.runtimeRoot = options.runtimeRoot
    this.child = child ?? null
    this.userDataDir = userDataDir ?? null
    this.client.onEvent((event) => this.handleEvent(event))
  }

  static async connect(
    webSocketDebuggerUrl: string,
    options: HeadlessChromeBrowserHostOptions,
    child?: ChildProcess,
    userDataDir?: string,
  ): Promise<HeadlessChromeBrowserHost> {
    const client = await CdpClient.connect(webSocketDebuggerUrl)
    return new HeadlessChromeBrowserHost(client, options, child, userDataDir)
  }

  async openPage(request: BrowserOpenRequest): Promise<BrowserPageHandle> {
    const resolved = await this.resolveOpenTarget(request)

    const tabId = createTabId()
    // Don't pass width/height: under --headless=new, Target.createTarget rejects
    // them ("Target position can only be set for new windows") unless
    // newWindow:true is also set, and a separate window makes Page.* commands
    // flaky. The viewport is applied below via Emulation.setDeviceMetricsOverride.
    const createResult = await this.client.send('Target.createTarget', {
      url: 'about:blank',
    }) as { targetId?: unknown }
    const targetId = typeof createResult.targetId === 'string' ? createResult.targetId : ''
    if (!targetId) throw new Error('Target.createTarget did not return targetId')

    const attachResult = await this.client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    }) as { sessionId?: unknown }
    const sessionId = typeof attachResult.sessionId === 'string' ? attachResult.sessionId : ''
    if (!sessionId) throw new Error('Target.attachToTarget did not return sessionId')

    const now = Date.now()
    const closeAfterIdleMs = resolveHeadlessCloseAfterIdleMs(request.closeAfterIdleMs)
    const record: PageRecord = {
      tabId,
      targetId,
      sessionId,
      viewport: request.viewport,
      type: resolved.type,
      target: resolved.target,
      title: request.title || resolved.title,
      params: request.params,
      logs: [],
      openedAt: now,
      lastUsedAt: now,
      closeAfterIdleMs,
      expiresAt: typeof closeAfterIdleMs === 'number' ? now + closeAfterIdleMs : null,
      idleTimer: null,
    }
    this.pages.set(tabId, record)
    this.scheduleIdleClose(record)

    await this.client.send('Page.enable', {}, sessionId)
    await this.client.send('Runtime.enable', {}, sessionId)
    await this.client.send('Log.enable', {}, sessionId)
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width: request.viewport.width,
      height: request.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId)
    // Surface params via location.search before any view script runs. Must be
    // registered before Page.navigate so it applies to the document we load
    // (and re-applies on reload).
    const paramsQuery = buildParamsQuery(request.params)
    if (paramsQuery) {
      await this.client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: paramsBootstrapScript(paramsQuery),
      }, sessionId)
    }
    // Subscribe before navigating so we can't miss the load event, then wait
    // for the page to finish loading. Without this, capture/reload issued right
    // after openTab race the navigation and fail with "Not attached to an
    // active page".
    const loaded = this.waitForPageLoad(sessionId)
    await this.client.send('Page.navigate', { url: resolved.url }, sessionId)
    await loaded

    return this.getPage(tabId)!
  }

  private waitForPageLoad(sessionId: string, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      const unsubscribe = this.client.onEvent((event) => {
        if (event.sessionId !== sessionId) return
        if (event.method === 'Page.loadEventFired' || event.method === 'Page.frameStoppedLoading') {
          finish()
        }
      })
    })
  }

  private async resolveOpenTarget(request: BrowserOpenRequest): Promise<{
    type: 'view' | 'file' | 'url'
    target: string
    title: string
    url: string
  }> {
    if (request.url) {
      return {
        type: 'url',
        target: request.url,
        title: 'Web Page',
        url: request.url,
      }
    }

    if (request.viewName) {
      const record = await getViewContent(this.runtimeRoot, request.viewName)
      if (!record) {
        throw new Error(`View not found: ${request.viewName}`)
      }
      return {
        type: 'view',
        target: request.viewName,
        title: record.title || request.viewName,
        url: htmlDataUrl(buildViewDocument(record.content)),
      }
    }

    if (request.filePath) {
      const absolutePath = await assertPathAllowed(this.runtimeRoot, request.filePath, { allowMissing: false })
      const content = await readFile(absolutePath, 'utf-8')
      return {
        type: 'file',
        target: request.filePath,
        title: 'File View',
        url: htmlDataUrl(buildViewDocument(content)),
      }
    }

    throw new Error('openTab requires one of viewName, filePath, or url')
  }

  async closePage(tabId: string): Promise<void> {
    const record = this.pages.get(tabId)
    if (!record) return
    this.pages.delete(tabId)
    if (record.idleTimer) clearTimeout(record.idleTimer)
    await this.client.send('Target.closeTarget', { targetId: record.targetId }).catch(() => undefined)
  }

  touchPage(tabId: string): void {
    const record = this.pages.get(tabId)
    if (!record) return
    record.lastUsedAt = Date.now()
    if (typeof record.closeAfterIdleMs === 'number') {
      record.expiresAt = record.lastUsedAt + record.closeAfterIdleMs
      this.scheduleIdleClose(record)
    }
  }

  getPage(tabId: string): BrowserPageHandle | null {
    const record = this.pages.get(tabId)
    if (!record) return null
    return new HeadlessChromePageHandle(this.client, record)
  }

  async getTabs(): Promise<TabData[]> {
    return [...this.pages.values()].map(record => ({
      id: record.tabId,
      tabId: record.tabId,
      type: record.type,
      title: record.title,
      target: record.target,
      headless: true,
      viewport: record.viewport,
      viewUpdatedAt: null,
      viewChanged: false,
      pinned: false,
      selected: false,
      params: record.params ?? null,
      openedAt: record.openedAt,
      lastUsedAt: record.lastUsedAt,
      closeAfterIdleMs: record.closeAfterIdleMs,
      expiresAt: record.expiresAt,
    }))
  }

  async dispose(): Promise<void> {
    for (const record of this.pages.values()) {
      if (record.idleTimer) clearTimeout(record.idleTimer)
    }
    this.pages.clear()
    this.client.close()
    this.child?.kill()
    if (this.userDataDir) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private handleEvent(event: CdpEvent): void {
    if (!event.sessionId) return
    const record = [...this.pages.values()].find(page => page.sessionId === event.sessionId)
    if (!record) return
    if (event.method === 'Runtime.consoleAPICalled') {
      const params = event.params as {
        type?: unknown
        args?: Array<{ value?: unknown; description?: string }>
      }
      record.logs.push({
        level: consoleLevel(String(params.type || 'info')),
        message: (params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' '),
        timestamp: Date.now(),
      })
      trimLogs(record.logs)
    } else if (event.method === 'Log.entryAdded') {
      const params = event.params as { entry?: { level?: unknown; text?: unknown } }
      record.logs.push({
        level: consoleLevel(String(params.entry?.level || 'info')),
        message: String(params.entry?.text || ''),
        timestamp: Date.now(),
      })
      trimLogs(record.logs)
    }
  }

  private scheduleIdleClose(record: PageRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer)
      record.idleTimer = null
    }
    if (typeof record.closeAfterIdleMs !== 'number') return

    const expiresAt = record.lastUsedAt + record.closeAfterIdleMs
    record.expiresAt = expiresAt
    record.idleTimer = setTimeout(() => {
      const current = this.pages.get(record.tabId)
      if (!current || typeof current.closeAfterIdleMs !== 'number') return
      const currentExpiresAt = current.lastUsedAt + current.closeAfterIdleMs
      if (Date.now() < currentExpiresAt) {
        current.expiresAt = currentExpiresAt
        this.scheduleIdleClose(current)
        return
      }
      void this.closePage(record.tabId)
    }, Math.max(1, expiresAt - Date.now()))
  }
}

class HeadlessChromePageHandle implements BrowserPageHandle {
  readonly tabId: string
  readonly viewport: Viewport

  constructor(
    private readonly client: CdpClient,
    private readonly record: PageRecord,
  ) {
    this.tabId = record.tabId
    this.viewport = record.viewport
  }

  sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    return this.client.send(method, params, sessionId || this.record.sessionId)
  }

  subscribeCdp(events: string[]): BrowserCdpSubscription {
    return new HeadlessChromeSubscription(this.client, this.record.sessionId, new Set(events))
  }

  async getConsoleLogs(request?: { since?: number; limit?: number }): Promise<TabConsoleLog[]> {
    const since = typeof request?.since === 'number' && Number.isFinite(request.since)
      ? request.since
      : undefined
    const limit = typeof request?.limit === 'number' && Number.isFinite(request.limit)
      ? Math.max(1, Math.floor(request.limit))
      : undefined
    const filtered = since === undefined
      ? this.record.logs.slice()
      : this.record.logs.filter(log => log.timestamp > since)
    return limit && filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered
  }
}

class HeadlessChromeSubscription implements BrowserCdpSubscription {
  private readonly buffer: TabDebuggerBufferedEvent[] = []
  private dropped = 0
  private closed = false
  private waiter: (() => void) | null = null
  private readonly unsubscribe: () => void

  constructor(
    client: CdpClient,
    private readonly sessionId: string,
    private readonly events: Set<string>,
  ) {
    this.unsubscribe = client.onEvent((event) => {
      if (event.sessionId !== this.sessionId) return
      if (!this.events.has('*') && !this.events.has(event.method)) return
      this.push({ method: event.method, params: event.params, sessionId: event.sessionId })
    })
  }

  async poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<TabDebuggerPollResult> {
    const maxBatch = Math.max(1, Math.min(1000, request?.maxBatch ?? 100))
    const maxWaitMs = Math.max(0, Math.min(POLL_MAX_WAIT_MS, request?.maxWaitMs ?? 30_000))
    if (this.buffer.length === 0 && !this.closed && maxWaitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.waiter === done) this.waiter = null
          resolve()
        }, maxWaitMs)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        this.waiter = done
      })
    }
    const events = this.buffer.splice(0, maxBatch)
    const dropped = this.dropped
    this.dropped = 0
    return { events, dropped, closed: this.closed && this.buffer.length === 0 }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.waiter?.()
    this.waiter = null
  }

  private push(event: TabDebuggerBufferedEvent): void {
    if (this.buffer.length >= SUBSCRIPTION_BUFFER_MAX) {
      this.buffer.shift()
      this.dropped++
    }
    this.buffer.push(event)
    this.waiter?.()
    this.waiter = null
  }
}

function trimLogs(logs: TabConsoleLog[]): void {
  if (logs.length > SUBSCRIPTION_BUFFER_MAX) {
    logs.splice(0, logs.length - SUBSCRIPTION_BUFFER_MAX)
  }
}

function consoleLevel(level: string): string {
  switch (level) {
    case 'debug':
      return 'verbose'
    case 'warning':
    case 'warn':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
}

function createTabId(): string {
  return `chrome-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`
}

// Build a query string from params, e.g. { foo: 'bar' } -> "foo=bar".
function buildParamsQuery(params?: Record<string, string>): string {
  if (!params) return ''
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

// A data: URL can't carry a readable query string (the `?` becomes part of the
// base64 data and breaks decoding), so we can't mirror buildTabSrc by appending
// to the URL. Instead inject a document-start script that rewrites the query
// via history.replaceState before any view script runs, so a view's
// `new URLSearchParams(location.search)` sees the params — matching the local
// path. replaceState works on the data: document's opaque origin as long as the
// path is unchanged.
function paramsBootstrapScript(query: string): string {
  return `try{history.replaceState(null,'',location.href.split('?')[0]+${JSON.stringify('?' + query)});}catch(e){}`
}
