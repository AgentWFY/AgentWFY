import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getViewContent } from '#shared/db/views.js'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import type {
  BrowserCdpSubscription,
  BrowserHost,
  BrowserOpenRequest,
  BrowserPageHandle,
  TabConsoleLog,
  TabData,
  TabDebuggerPollResult,
  Viewport,
} from '#shared/runtime/hosts.js'
import {
  resolveHeadlessCloseAfterIdleMs,
  type HeadlessCloseAfterIdleMs,
} from '#shared/runtime/hosts.js'
import { CdpClient, type CdpEvent } from '#shared/browser/cdp-client.js'
import { PageCdpEventBuffer, PAGE_CDP_SUBSCRIPTION_BUFFER_MAX } from '#shared/page/cdp-subscription-manager.js'
import { IdleCloseScheduler, type IdleCloseEntry } from '#shared/page/idle-close.js'
import type { HeadlessViewRuntime } from './headless-view-runtime.js'

interface HeadlessChromeBrowserHostOptions {
  runtimeRoot: string
  viewRuntime?: HeadlessViewRuntime
}

interface PageRecord extends IdleCloseEntry {
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
  private readonly viewRuntime: HeadlessViewRuntime | null
  private readonly child: ChildProcess | null
  private readonly userDataDir: string | null
  private readonly idleClose: IdleCloseScheduler<PageRecord>

  private constructor(
    client: CdpClient,
    options: HeadlessChromeBrowserHostOptions,
    child?: ChildProcess,
    userDataDir?: string,
  ) {
    this.client = client
    this.runtimeRoot = options.runtimeRoot
    this.viewRuntime = options.viewRuntime ?? null
    this.child = child ?? null
    this.userDataDir = userDataDir ?? null
    this.idleClose = new IdleCloseScheduler<PageRecord>({
      getEntry: tabId => this.pages.get(tabId),
      closeEntry: tabId => this.closePage(tabId),
    })
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
    const tabId = createTabId()
    const usesViewRuntime = Boolean(request.viewName || request.filePath)
    if (usesViewRuntime) {
      if (!this.viewRuntime) {
        throw new Error('Headless view runtime is not available')
      }
      this.viewRuntime.registerPage(tabId)
    }

    let targetId: string | null = null
    try {
      const resolved = await this.resolveOpenTarget(request, tabId)

      // Don't pass width/height: under --headless=new, Target.createTarget rejects
      // them ("Target position can only be set for new windows") unless
      // newWindow:true is also set, and a separate window makes Page.* commands
      // flaky. The viewport is applied below via Emulation.setDeviceMetricsOverride.
      const createResult = await this.client.send('Target.createTarget', {
        url: 'about:blank',
      }) as { targetId?: unknown }
      targetId = typeof createResult.targetId === 'string' ? createResult.targetId : ''
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
      }
      this.pages.set(tabId, record)
      this.idleClose.schedule(tabId)

      await this.client.send('Page.enable', {}, sessionId)
      await this.client.send('Runtime.enable', {}, sessionId)
      await this.client.send('Log.enable', {}, sessionId)
      await this.client.send('Emulation.setDeviceMetricsOverride', {
        width: request.viewport.width,
        height: request.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId)
      // Subscribe before navigating so we can't miss the load event, then wait
      // for the page to finish loading. Without this, capture/reload issued right
      // after openTab race the navigation and fail with "Not attached to an
      // active page".
      const loaded = this.waitForPageLoad(sessionId)
      await this.client.send('Page.navigate', { url: resolved.url }, sessionId)
      await loaded

      return this.getPage(tabId)!
    } catch (err) {
      this.pages.delete(tabId)
      if (usesViewRuntime) this.viewRuntime?.unregisterPage(tabId)
      if (targetId) {
        await this.client.send('Target.closeTarget', { targetId }).catch(() => undefined)
      }
      throw err
    }
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

  private async resolveOpenTarget(request: BrowserOpenRequest, tabId: string): Promise<{
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
        url: await this.viewRuntime!.buildDocumentUrl({
          pageId: tabId,
          kind: 'view',
          target: request.viewName,
          params: request.params,
        }),
      }
    }

    if (request.filePath) {
      const absolutePath = await assertPathAllowed(this.runtimeRoot, request.filePath, { allowMissing: false })
      await readFile(absolutePath, 'utf-8')
      return {
        type: 'file',
        target: request.filePath,
        title: 'File View',
        url: await this.viewRuntime!.buildDocumentUrl({
          pageId: tabId,
          kind: 'file-view',
          target: request.filePath,
          params: request.params,
        }),
      }
    }

    throw new Error('openTab requires one of viewName, filePath, or url')
  }

  async closePage(tabId: string): Promise<void> {
    const record = this.pages.get(tabId)
    if (!record) return
    this.pages.delete(tabId)
    this.viewRuntime?.unregisterPage(tabId)
    this.idleClose.clear(tabId)
    await this.client.send('Target.closeTarget', { targetId: record.targetId }).catch(() => undefined)
  }

  touchPage(tabId: string): void {
    this.idleClose.touch(tabId)
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
    this.idleClose.clearAll()
    for (const record of this.pages.values()) {
      this.viewRuntime?.unregisterPage(record.tabId)
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
  private readonly buffer: PageCdpEventBuffer
  private readonly unsubscribe: () => void

  constructor(
    client: CdpClient,
    private readonly sessionId: string,
    events: Set<string>,
  ) {
    this.buffer = new PageCdpEventBuffer({
      subscriptionId: `chrome-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      pageId: sessionId,
      events: [...events],
    })
    this.unsubscribe = client.onEvent((event) => {
      if (event.sessionId !== this.sessionId) return
      this.buffer.push({ method: event.method, params: event.params, sessionId: event.sessionId })
    })
  }

  async poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<TabDebuggerPollResult> {
    return this.buffer.poll(request)
  }

  async close(): Promise<void> {
    this.unsubscribe()
    await this.buffer.close()
  }
}

function trimLogs(logs: TabConsoleLog[]): void {
  if (logs.length > PAGE_CDP_SUBSCRIPTION_BUFFER_MAX) {
    logs.splice(0, logs.length - PAGE_CDP_SUBSCRIPTION_BUFFER_MAX)
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
