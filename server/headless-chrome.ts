import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getViewContent } from '#shared/db/views.js'
import { assertPathAllowed } from '#shared/security/path-policy.js'
import { CdpClient, type CdpEvent } from '#shared/browser/cdp-client.js'
import {
  capture as captureWithCdp,
  dispatchInput,
  execJs as execJsWithCdp,
  inspect as inspectWithCdp,
  isNotAttachedError,
  type CdpPageHandle,
} from '#shared/browser/cdp-ops.js'
import { PageCdpEventBuffer, PAGE_CDP_SUBSCRIPTION_BUFFER_MAX } from '#shared/page/cdp-subscription-manager.js'
import {
  IdleCloseScheduler,
  resolvePageCloseAfterIdleMs,
  type IdleCloseEntry,
} from '#shared/page/idle-close.js'
import type { PageHandle } from '#shared/page/page-handle.js'
import type { PageHost, PageHostOpenRequest, PageOpenContext } from '#shared/page/page-host.js'
import type {
  OpenPageRequest,
  PageCapabilities,
  PageCdpPollResult,
  PageCdpSubscription,
  PageCloseAfterIdleMs,
  PageConsoleLog,
  PageInfo,
  PageInputRequest,
  PageOwner,
  PageScreenshot,
  PageSource,
  PageViewport,
} from '#shared/page/types.js'
import type { HeadlessViewRuntime } from './headless-view-runtime.js'

const RELOAD_RETRY_BUDGET_MS = 3000

const VIEWPORT_ALIASES: Record<string, PageViewport> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
}

const DAEMON_HEADLESS_CAPABILITIES: PageCapabilities = {
  screenshot: true,
  js: true,
  input: true,
  consoleLogs: true,
  inspect: true,
  cdp: true,
  screencast: true,
}

interface DaemonHeadlessPageHostOptions {
  runtimeRoot: string
  agentId: string
  viewRuntime?: HeadlessViewRuntime
}

interface ResolvedOpenTarget {
  source: PageSource
  title: string
  url: string
  currentUrl?: string
}

interface PageRecord extends IdleCloseEntry {
  pageId: string
  targetId: string
  sessionId: string
  viewport: PageViewport
  source: PageSource
  currentUrl?: string
  title: string
  owner: PageOwner
  createdBy: PageInfo['createdBy']
  lifecycle: PageInfo['lifecycle']
  logs: PageConsoleLog[]
  openedAt: number
  lastUsedAt: number
  closeAfterIdleMs: PageCloseAfterIdleMs
  expiresAt: number | null
  lastError?: PageInfo['lastError']
}

export async function createDaemonHeadlessPageHostFromEnv(
  options: DaemonHeadlessPageHostOptions,
): Promise<DaemonHeadlessPageHost | null> {
  const cdpUrl = process.env['AGENTWFY_BROWSER_CDP_URL']
  const executable = process.env['AGENTWFY_BROWSER_EXECUTABLE']
  if (cdpUrl && cdpUrl.trim()) {
    return DaemonHeadlessPageHost.connect(await resolveBrowserWebSocketUrl(cdpUrl.trim()), options)
  }
  if (executable && executable.trim()) {
    return launchHeadlessChrome(executable.trim(), options)
  }
  return null
}

async function launchHeadlessChrome(
  executable: string,
  options: DaemonHeadlessPageHostOptions,
): Promise<DaemonHeadlessPageHost> {
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
    return await DaemonHeadlessPageHost.connect(wsUrl, options, child, userDataDir)
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

export class DaemonHeadlessPageHost implements PageHost {
  readonly hostKind = 'daemon-headless' as const

  private readonly pages = new Map<string, PageRecord>()
  private readonly subscriptions = new Map<string, Set<DaemonHeadlessChromeSubscription>>()
  private readonly client: CdpClient
  private readonly runtimeRoot: string
  private readonly viewRuntime: HeadlessViewRuntime | null
  private readonly child: ChildProcess | null
  private readonly userDataDir: string | null
  private readonly idleClose: IdleCloseScheduler<PageRecord>

  private constructor(
    client: CdpClient,
    options: DaemonHeadlessPageHostOptions,
    child?: ChildProcess,
    userDataDir?: string,
  ) {
    this.client = client
    this.runtimeRoot = options.runtimeRoot
    this.viewRuntime = options.viewRuntime ?? null
    this.child = child ?? null
    this.userDataDir = userDataDir ?? null
    this.idleClose = new IdleCloseScheduler<PageRecord>({
      getEntry: pageId => this.pages.get(pageId),
      closeEntry: pageId => this.closePage(pageId),
    })
    this.client.onEvent((event) => this.handleEvent(event))
  }

  static async connect(
    webSocketDebuggerUrl: string,
    options: DaemonHeadlessPageHostOptions,
    child?: ChildProcess,
    userDataDir?: string,
  ): Promise<DaemonHeadlessPageHost> {
    const client = await CdpClient.connect(webSocketDebuggerUrl)
    return new DaemonHeadlessPageHost(client, options, child, userDataDir)
  }

  canOpen(request: OpenPageRequest, _context: PageOpenContext): boolean {
    return request.display === 'headless'
  }

  async openPage(request: PageHostOpenRequest): Promise<PageHandle> {
    const pageId = request.pageId
    if (this.pages.has(pageId)) {
      throw new Error(`Daemon headless page already exists: ${pageId}`)
    }

    const usesViewRuntime = request.source.type !== 'url'
    if (usesViewRuntime) {
      if (!this.viewRuntime) {
        throw new Error('Headless view runtime is not available')
      }
      this.viewRuntime.registerPage(pageId)
    }

    let targetId: string | null = null
    try {
      const resolved = await this.resolveOpenTarget(request)

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
      const closeAfterIdleMs = resolvePageCloseAfterIdleMs(request.closeAfterIdleMs)
      const viewport = resolveDaemonViewport(request.viewport, request.width, request.height)
      const record: PageRecord = {
        pageId,
        targetId,
        sessionId,
        viewport,
        source: resolved.source,
        title: request.title || resolved.title,
        ...(resolved.currentUrl ? { currentUrl: resolved.currentUrl } : {}),
        owner: request.owner,
        createdBy: request.createdBy ?? 'agent',
        lifecycle: 'opening',
        logs: [],
        openedAt: now,
        lastUsedAt: now,
        closeAfterIdleMs,
        expiresAt: typeof closeAfterIdleMs === 'number' ? now + closeAfterIdleMs : null,
      }
      this.pages.set(pageId, record)
      this.idleClose.schedule(pageId)

      await this.client.send('Page.enable', {}, sessionId)
      await this.client.send('Runtime.enable', {}, sessionId)
      await this.client.send('Log.enable', {}, sessionId)
      await this.client.send('Emulation.setDeviceMetricsOverride', {
        width: record.viewport.width,
        height: record.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId)
      // Subscribe before navigating so we can't miss the load event. Without
      // this, capture/reload issued right after openPage can race navigation
      // and fail with "Not attached to an active page".
      const loaded = this.awaitTargetLoad(sessionId)
      await this.client.send('Page.navigate', { url: resolved.url }, sessionId)
      await loaded
      record.lifecycle = 'ready'
      delete record.lastError

      const handle = await this.getPage(pageId)
      if (!handle) throw new Error(`Failed to create daemon headless page "${pageId}"`)
      return handle
    } catch (err) {
      this.pages.delete(pageId)
      this.idleClose.clear(pageId)
      if (usesViewRuntime) this.viewRuntime?.unregisterPage(pageId)
      if (targetId) {
        await this.client.send('Target.closeTarget', { targetId }).catch(() => undefined)
      }
      throw err
    }
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    const record = this.pages.get(pageId)
    return record ? new DaemonHeadlessChromePageHandle(this, record) : null
  }

  async listPages(): Promise<PageInfo[]> {
    return [...this.pages.values()].map(record => this.pageInfoFromRecord(record))
  }

  pageInfoFromRecord(record: PageRecord): PageInfo {
    return {
      pageId: record.pageId,
      title: record.title,
      source: record.source,
      ...(record.source.type === 'url' && record.currentUrl ? { currentUrl: record.currentUrl } : {}),
      display: 'headless',
      lifecycle: record.lifecycle,
      capabilities: DAEMON_HEADLESS_CAPABILITIES,
      viewport: record.viewport,
      owner: record.owner,
      createdBy: record.createdBy,
      content: {
        stale: false,
      },
      openedAt: record.openedAt,
      lastUsedAt: record.lastUsedAt,
      closeAfterIdleMs: record.closeAfterIdleMs,
      ...(record.expiresAt !== null ? { expiresAt: record.expiresAt } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
    }
  }

  async closePage(pageId: string): Promise<void> {
    const record = this.pages.get(pageId)
    if (!record) return
    this.pages.delete(pageId)
    this.viewRuntime?.unregisterPage(pageId)
    this.idleClose.clear(pageId)
    await this.closeSubscriptionsForPage(pageId)
    await this.client.send('Target.closeTarget', { targetId: record.targetId }).catch(() => undefined)
  }

  touchPage(pageId: string): PageRecord | null {
    return this.idleClose.touch(pageId)
  }

  async reloadPage(pageId: string): Promise<void> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    record.lifecycle = 'opening'
    const loaded = this.awaitTargetLoad(record.sessionId)
    const deadline = Date.now() + RELOAD_RETRY_BUDGET_MS
    try {
      while (true) {
        try {
          await this.client.send('Page.reload', {}, record.sessionId)
          break
        } catch (err) {
          if (!isNotAttachedError(err) || Date.now() >= deadline) throw err
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
      }
      await loaded
      record.lifecycle = 'ready'
      delete record.lastError
    } catch (err) {
      record.lifecycle = 'failed'
      record.lastError = pageError(err)
      throw err
    }
  }

  async capturePage(pageId: string): Promise<PageScreenshot> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    const result = await captureWithCdp(this.cdpHandle(record))
    return {
      ...result,
      pageId,
      capturedPageId: pageId,
    }
  }

  async runPageJs(pageId: string, code: string, timeoutMs?: number): Promise<unknown> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    return execJsWithCdp(this.cdpHandle(record), code, timeoutMs)
  }

  async sendPageInput(pageId: string, input: PageInputRequest): Promise<void> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    await dispatchInput(this.cdpHandle(record), input)
  }

  async inspectPageElement(pageId: string, selector: string): Promise<unknown> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    return inspectWithCdp(this.cdpHandle(record), selector)
  }

  async getConsoleLogs(pageId: string, request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    const since = typeof request?.since === 'number' && Number.isFinite(request.since)
      ? request.since
      : undefined
    const limit = typeof request?.limit === 'number' && Number.isFinite(request.limit)
      ? Math.max(1, Math.floor(request.limit))
      : undefined
    const filtered = since === undefined
      ? record.logs.slice()
      : record.logs.filter(log => log.timestamp > since)
    return limit && filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered
  }

  async sendCdp(pageId: string, method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    return this.client.send(method, params, sessionId || record.sessionId)
  }

  async subscribeCdp(pageId: string, events: string[]): Promise<PageCdpSubscription> {
    const record = this.requireRecord(pageId)
    this.touchPage(pageId)
    const subscription = new DaemonHeadlessChromeSubscription(
      this.client,
      record,
      events,
      () => this.touchPage(pageId),
      () => this.forgetSubscription(pageId, subscription),
    )
    let subscriptions = this.subscriptions.get(pageId)
    if (!subscriptions) {
      subscriptions = new Set()
      this.subscriptions.set(pageId, subscriptions)
    }
    subscriptions.add(subscription)
    return subscription
  }

  async detachCdp(pageId: string): Promise<void> {
    await this.sendCdp(pageId, 'Runtime.disable').catch(() => {})
    await this.closeSubscriptionsForPage(pageId)
  }

  async dispose(): Promise<void> {
    this.idleClose.clearAll()
    for (const pageId of [...this.pages.keys()]) {
      await this.closePage(pageId).catch((err) => {
        console.warn('[headless-chrome] close page failed during dispose:', err)
      })
    }
    this.client.close()
    this.child?.kill()
    if (this.userDataDir) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private awaitTargetLoad(sessionId: string, timeoutMs = 10_000): Promise<void> {
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

  private async resolveOpenTarget(request: PageHostOpenRequest): Promise<ResolvedOpenTarget> {
    switch (request.source.type) {
      case 'url':
        return {
          source: request.source,
          title: 'Web Page',
          url: request.source.url,
          currentUrl: request.source.url,
        }
      case 'view': {
        const record = await getViewContent(this.runtimeRoot, request.source.name)
        if (!record) {
          throw new Error(`View not found: ${request.source.name}`)
        }
        return {
          source: request.source,
          title: record.title || request.source.name,
          url: await this.requireViewRuntime().buildDocumentUrl({
            pageId: request.pageId,
            kind: 'view',
            target: request.source.name,
            params: request.source.params,
          }),
        }
      }
      case 'file': {
        const absolutePath = await assertPathAllowed(this.runtimeRoot, request.source.path, { allowMissing: false })
        await readFile(absolutePath, 'utf-8')
        return {
          source: request.source,
          title: 'File View',
          url: await this.requireViewRuntime().buildDocumentUrl({
            pageId: request.pageId,
            kind: 'file-view',
            target: request.source.path,
            params: request.source.params,
          }),
        }
      }
    }
  }

  private requireViewRuntime(): HeadlessViewRuntime {
    if (!this.viewRuntime) {
      throw new Error('Headless view runtime is not available')
    }
    return this.viewRuntime
  }

  private cdpHandle(record: PageRecord): CdpPageHandle {
    return {
      sendCdp: (method, params, sessionId) => this.sendCdp(record.pageId, method, params, sessionId),
      getConsoleLogs: request => this.getConsoleLogs(record.pageId, request),
    }
  }

  private requireRecord(pageId: string): PageRecord {
    const record = this.pages.get(pageId)
    if (!record) {
      throw new Error(`Page not found: ${pageId}`)
    }
    return record
  }

  private async closeSubscriptionsForPage(pageId: string): Promise<void> {
    const subscriptions = this.subscriptions.get(pageId)
    if (!subscriptions) return
    this.subscriptions.delete(pageId)
    await Promise.all([...subscriptions].map(subscription => subscription.close().catch(() => undefined)))
  }

  private forgetSubscription(pageId: string, subscription: DaemonHeadlessChromeSubscription): void {
    const subscriptions = this.subscriptions.get(pageId)
    if (!subscriptions) return
    subscriptions.delete(subscription)
    if (subscriptions.size === 0) this.subscriptions.delete(pageId)
  }

  private handleEvent(event: CdpEvent): void {
    const record = this.recordForEvent(event)
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
      return
    }

    if (event.method === 'Log.entryAdded') {
      const params = event.params as { entry?: { level?: unknown; text?: unknown } }
      record.logs.push({
        level: consoleLevel(String(params.entry?.level || 'info')),
        message: String(params.entry?.text || ''),
        timestamp: Date.now(),
      })
      trimLogs(record.logs)
      return
    }

    if (event.method === 'Page.frameNavigated' && record.source.type === 'url') {
      const params = event.params as { frame?: { parentId?: unknown; url?: unknown } }
      if (!params.frame?.parentId && typeof params.frame?.url === 'string') {
        record.currentUrl = params.frame.url
      }
      return
    }

    if (event.method === 'Inspector.targetCrashed' || event.method === 'Target.targetCrashed') {
      record.lifecycle = 'crashed'
      record.lastError = { message: 'Chrome target crashed' }
    }
  }

  private recordForEvent(event: CdpEvent): PageRecord | null {
    if (event.sessionId) {
      return [...this.pages.values()].find(page => page.sessionId === event.sessionId) ?? null
    }
    const params = event.params as { targetId?: unknown }
    if (typeof params.targetId !== 'string') return null
    return [...this.pages.values()].find(page => page.targetId === params.targetId) ?? null
  }
}

class DaemonHeadlessChromePageHandle implements PageHandle {
  readonly pageId: string

  constructor(
    private readonly host: DaemonHeadlessPageHost,
    private readonly record: PageRecord,
  ) {
    this.pageId = record.pageId
  }

  info(): PageInfo {
    return this.host.pageInfoFromRecord(this.record)
  }

  async close(): Promise<void> {
    await this.host.closePage(this.pageId)
  }

  async reload(): Promise<void> {
    await this.host.reloadPage(this.pageId)
  }

  async capture(): Promise<PageScreenshot> {
    return this.host.capturePage(this.pageId)
  }

  async runJs(code: string, timeoutMs?: number): Promise<unknown> {
    return this.host.runPageJs(this.pageId, code, timeoutMs)
  }

  async sendInput(input: PageInputRequest): Promise<void> {
    await this.host.sendPageInput(this.pageId, input)
  }

  async inspectElement(selector: string): Promise<unknown> {
    return this.host.inspectPageElement(this.pageId, selector)
  }

  async getConsoleLogs(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]> {
    return this.host.getConsoleLogs(this.pageId, request)
  }

  async sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    return this.host.sendCdp(this.pageId, method, params, sessionId)
  }

  async subscribeCdp(events: string[]): Promise<PageCdpSubscription> {
    return this.host.subscribeCdp(this.pageId, events)
  }

  async detachCdp(): Promise<void> {
    await this.host.detachCdp(this.pageId)
  }
}

class DaemonHeadlessChromeSubscription implements PageCdpSubscription {
  private readonly buffer: PageCdpEventBuffer
  private readonly unsubscribe: () => void
  private closed = false

  constructor(
    client: CdpClient,
    private readonly record: PageRecord,
    events: string[],
    private readonly touch: () => void,
    private readonly onClose: () => void,
  ) {
    this.buffer = new PageCdpEventBuffer({
      subscriptionId: `chrome-${record.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      pageId: record.pageId,
      events,
    })
    this.unsubscribe = client.onEvent((event) => {
      if (event.sessionId !== this.record.sessionId) return
      this.buffer.push({ method: event.method, params: event.params, sessionId: event.sessionId })
    })
  }

  async poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult> {
    this.touch()
    return this.buffer.poll(request)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.onClose()
    await this.buffer.close()
  }
}

function trimLogs(logs: PageConsoleLog[]): void {
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

function pageError(error: unknown): NonNullable<PageInfo['lastError']> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      message: error.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    }
  }
  return { message: String(error) }
}

function resolveDaemonViewport(input: unknown, width: unknown, height: unknown): PageViewport {
  if (typeof input === 'string') {
    return VIEWPORT_ALIASES[input] ?? VIEWPORT_ALIASES.desktop
  }
  const viewport = input && typeof input === 'object'
    ? input as { width?: unknown; height?: unknown }
    : {}
  return {
    width: normalizeViewportDimension(viewport.width ?? width, VIEWPORT_ALIASES.desktop.width),
    height: normalizeViewportDimension(viewport.height ?? height, VIEWPORT_ALIASES.desktop.height),
  }
}

function normalizeViewportDimension(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(parsed))
}
