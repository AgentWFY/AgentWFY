import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { getModuleContent, getModuleContentType } from '#shared/db/modules.js'
import { getViewContent } from '#shared/db/views.js'
import { buildViewDocument } from '#shared/protocol/view-document.js'
import { serveFile } from '#shared/protocol/file-server.js'
import type { FunctionRegistry } from '#shared/runtime/function_registry.js'
import { assertPathAllowed } from '#shared/security/path-policy.js'

const MAX_BODY_BYTES = 10 * 1024 * 1024
const BRIDGE_TOKEN_QUERY_PARAM = 'bridgeToken'
const BRIDGE_TOKEN_HEADER = 'x-agentwfy-bridge-token'

interface RegisteredPage {
  pageId: string
  token: string
}

interface HeadlessRoute {
  agentId: string
  pageId: string
  action: string
  target: string
}

type RootRoute =
  | { kind: 'module'; target: string }
  | { kind: 'file'; target: string }
  | { kind: 'asset'; target: string }
  | { kind: 'bare-file'; target: string }

export interface HeadlessViewRuntimeOptions {
  runtimeRoot: string
  agentId: string
}

export class HeadlessViewRuntime {
  private readonly runtimeRoot: string
  private readonly agentId: string
  private readonly pages = new Map<string, RegisteredPage>()
  private functionRegistry: FunctionRegistry | null = null
  private server: Server | null = null
  private baseUrl: string | null = null
  private startPromise: Promise<void> | null = null

  constructor(options: HeadlessViewRuntimeOptions) {
    this.runtimeRoot = options.runtimeRoot
    this.agentId = options.agentId
  }

  setFunctionRegistry(registry: FunctionRegistry): void {
    this.functionRegistry = registry
  }

  async ensureStarted(): Promise<void> {
    if (this.baseUrl) return
    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((err) => {
          console.warn('[headless-view-runtime] request failed:', err)
          if (!res.headersSent) {
            sendPlain(res, 500, 'Internal Server Error\n')
          } else {
            res.destroy(err instanceof Error ? err : new Error(String(err)))
          }
        })
      })

      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address !== 'object') {
          reject(new Error('Headless view runtime did not receive a TCP port'))
          return
        }
        this.server = server
        this.baseUrl = `http://127.0.0.1:${address.port}`
        console.log(`[headless-view-runtime] listening on ${this.baseUrl}`)
        resolve()
      })
    }).finally(() => {
      this.startPromise = null
    })

    await this.startPromise
  }

  async close(): Promise<void> {
    this.pages.clear()
    const server = this.server
    this.server = null
    this.baseUrl = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
      server.closeAllConnections()
    })
  }

  registerPage(pageId: string): RegisteredPage {
    const page: RegisteredPage = {
      pageId,
      token: randomBytes(32).toString('base64url'),
    }
    this.pages.set(pageId, page)
    return page
  }

  unregisterPage(pageId: string): void {
    this.pages.delete(pageId)
  }

  async buildDocumentUrl(request: {
    pageId: string
    kind: 'view' | 'file-view'
    target: string
    params?: Record<string, string>
  }): Promise<string> {
    await this.ensureStarted()
    const page = this.pages.get(request.pageId)
    if (!page) throw new Error(`Headless view page is not registered: ${request.pageId}`)
    const baseUrl = this.baseUrl
    if (!baseUrl) throw new Error('Headless view runtime is not listening')

    const url = new URL(
      `/agent/${encodeURIComponent(this.agentId)}/headless/${encodeURIComponent(request.pageId)}/${request.kind}/${encodePath(request.target)}`,
      baseUrl,
    )
    if (request.params) {
      for (const [key, value] of Object.entries(request.params)) {
        url.searchParams.set(key, value)
      }
    }
    url.searchParams.set('pageId', request.pageId)
    url.searchParams.set('rev', String(Date.now()))
    url.searchParams.set(BRIDGE_TOKEN_QUERY_PARAM, page.token)
    return url.toString()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase()
    const url = new URL(req.url || '/', this.baseUrl || 'http://127.0.0.1')
    const route = parseHeadlessRoute(url.pathname)

    if (route) {
      if (route.agentId !== this.agentId) {
        sendPlain(res, 404, 'Not Found\n')
        return
      }
      if (route.action === 'runtime-call') {
        if (method !== 'POST') {
          sendPlain(res, 405, 'Method Not Allowed\n')
          return
        }
        await this.handleRuntimeCall(req, res, route)
        return
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendPlain(res, 405, 'Method Not Allowed\n')
        return
      }
      await this.handleHeadlessGet(req, res, url, route, method === 'HEAD')
      return
    }

    const rootRoute = parseRootRoute(url.pathname)
    if (!rootRoute || (method !== 'GET' && method !== 'HEAD')) {
      sendPlain(res, 404, 'Not Found\n')
      return
    }

    const page = this.resolvePageFromRequest(req, url)
    if (!page) {
      sendPlain(res, 401, 'Unauthorized\n')
      return
    }
    await this.serveRootRoute(req, res, url, rootRoute, method === 'HEAD')
  }

  private async handleHeadlessGet(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: HeadlessRoute,
    headOnly: boolean,
  ): Promise<void> {
    const page = this.validatePage(route.pageId, url.searchParams.get(BRIDGE_TOKEN_QUERY_PARAM))
    if (!page) {
      sendPlain(res, 401, 'Unauthorized\n')
      return
    }

    switch (route.action) {
      case 'view':
        await this.serveViewDocument(res, route.target, page, headOnly)
        return
      case 'file-view':
        await this.serveFileViewDocument(res, route.target, page, headOnly)
        return
      case 'module':
        await this.serveModule(res, route.target, headOnly)
        return
      case 'file':
        await this.serveAgentFile(req, res, url, route.target, headOnly)
        return
      case 'asset':
        sendPlain(res, 404, 'Asset not available in daemon headless views\n')
        return
      default:
        sendPlain(res, 404, 'Not Found\n')
        return
    }
  }

  private async serveRootRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: RootRoute,
    headOnly: boolean,
  ): Promise<void> {
    switch (route.kind) {
      case 'module':
        await this.serveModule(res, route.target, headOnly)
        return
      case 'file':
      case 'bare-file':
        await this.serveAgentFile(req, res, url, route.target, headOnly)
        return
      case 'asset':
        sendPlain(res, 404, 'Asset not available in daemon headless views\n')
        return
    }
  }

  private async serveViewDocument(
    res: ServerResponse,
    viewName: string,
    page: RegisteredPage,
    headOnly: boolean,
  ): Promise<void> {
    const record = await getViewContent(this.runtimeRoot, viewName)
    if (!record) {
      sendHtml(res, 404, `<pre>View not found: ${escapeHtml(viewName)}</pre>`, headOnly)
      return
    }
    sendHtml(res, 200, this.buildDaemonViewDocument(record.content, page), headOnly)
  }

  private async serveFileViewDocument(
    res: ServerResponse,
    filePath: string,
    page: RegisteredPage,
    headOnly: boolean,
  ): Promise<void> {
    let content: string
    try {
      const absolutePath = await assertPathAllowed(this.runtimeRoot, filePath, { allowMissing: false })
      content = await readFile(absolutePath, 'utf-8')
    } catch {
      sendHtml(res, 404, `<pre>File not found: ${escapeHtml(filePath)}</pre>`, headOnly)
      return
    }
    sendHtml(res, 200, this.buildDaemonViewDocument(content, page), headOnly)
  }

  private async serveModule(res: ServerResponse, moduleName: string, headOnly: boolean): Promise<void> {
    const record = await getModuleContent(this.runtimeRoot, moduleName)
    if (!record) {
      sendPlain(res, 404, `Module not found: ${moduleName}\n`)
      return
    }
    sendText(res, 200, record.content, getModuleContentType(record.name), headOnly)
  }

  private async serveAgentFile(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    relPath: string,
    headOnly: boolean,
  ): Promise<void> {
    if (!relPath) {
      sendPlain(res, 404, 'Empty path\n')
      return
    }
    let absolutePath: string
    try {
      absolutePath = await assertPathAllowed(this.runtimeRoot, relPath, { allowMissing: false })
    } catch {
      sendPlain(res, 404, 'Not Found\n')
      return
    }
    const response = await serveFile(toWebRequest(req, url), absolutePath)
    await writeWebResponse(res, response, headOnly)
  }

  private async handleRuntimeCall(
    req: IncomingMessage,
    res: ServerResponse,
    route: HeadlessRoute,
  ): Promise<void> {
    const token = headerValue(req.headers[BRIDGE_TOKEN_HEADER])
    const page = this.validatePage(route.pageId, token)
    if (!page) {
      sendJson(res, 401, { ok: false, error: { name: 'Error', message: 'Unauthorized' } })
      return
    }

    const registry = this.functionRegistry
    if (!registry) {
      sendJson(res, 503, { ok: false, error: { name: 'Error', message: 'Runtime is not ready' } })
      return
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch (err) {
      sendJson(res, 400, { ok: false, error: normalizeError(err) })
      return
    }

    const call = body && typeof body === 'object' ? body as { name?: unknown; params?: unknown } : {}
    if (typeof call.name !== 'string' || call.name.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: { name: 'Error', message: 'runtime-call requires a function name' } })
      return
    }

    try {
      const value = await registry.call(call.name.trim(), call.params)
      sendJson(res, 200, { ok: true, value })
    } catch (err) {
      sendJson(res, 200, { ok: false, error: normalizeError(err) })
    }
  }

  private buildDaemonViewDocument(content: string, page: RegisteredPage): string {
    return buildViewDocument(injectHeadStart(content, this.buildBridgeScript(page)))
  }

  private buildBridgeScript(page: RegisteredPage): string {
    const endpoint = `/agent/${encodeURIComponent(this.agentId)}/headless/${encodeURIComponent(page.pageId)}/runtime-call`
    return `<script>
(() => {
  if (window.agentwfy) return;
  const ENDPOINT = ${JSON.stringify(endpoint)};
  const TOKEN = ${JSON.stringify(page.token)};

  function normalizeError(error) {
    if (!error || typeof error !== 'object') {
      return new Error(String(error || 'Unknown agentwfy error'));
    }
    const err = new Error(typeof error.message === 'string' ? error.message : 'Unknown agentwfy error');
    if (typeof error.name === 'string' && error.name) err.name = error.name;
    if ('code' in error) err.code = error.code;
    if ('details' in error) err.details = error.details;
    return err;
  }

  async function invoke(name, params) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ${JSON.stringify(BRIDGE_TOKEN_HEADER)}: TOKEN,
      },
      body: JSON.stringify({ name, params }),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      throw new Error('Invalid agentwfy runtime response');
    }
    if (!response.ok || !data || data.ok !== true) {
      throw normalizeError(data && data.error);
    }
    return data.value;
  }

  const cache = new Map();
  const api = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = (params) => invoke(prop, params);
        cache.set(prop, fn);
      }
      return fn;
    },
  });

  Object.defineProperty(window, 'agentwfy', {
    value: api,
    configurable: false,
    enumerable: true,
    writable: false,
  });
})();
</script>`
  }

  private validatePage(pageId: string, token: string | null): RegisteredPage | null {
    const page = this.pages.get(pageId)
    if (!page || !token || page.token !== token) return null
    return page
  }

  private resolvePageFromRequest(req: IncomingMessage, url: URL): RegisteredPage | null {
    const queryPageId = url.searchParams.get('pageId')
    const queryToken = url.searchParams.get(BRIDGE_TOKEN_QUERY_PARAM)
    if (queryPageId && queryToken) {
      const page = this.validatePage(queryPageId, queryToken)
      if (page) return page
    }

    const referer = headerValue(req.headers.referer)
    if (!referer) return null
    let refererUrl: URL
    try {
      refererUrl = new URL(referer)
    } catch {
      return null
    }
    if (this.baseUrl && refererUrl.origin !== new URL(this.baseUrl).origin) return null
    const route = parseHeadlessRoute(refererUrl.pathname)
    if (!route || route.agentId !== this.agentId) return null
    return this.validatePage(route.pageId, refererUrl.searchParams.get(BRIDGE_TOKEN_QUERY_PARAM))
  }
}

function injectHeadStart(source: string, injection: string): string {
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (match) => `${match}${injection}`)
  }
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (match) => `${match}<head>${injection}</head>`)
  }
  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/<body[^>]*>/i, (match) => `<head>${injection}</head>${match}`)
  }
  return `<!doctype html><html><head>${injection}</head><body>${source}</body></html>`
}

function parseHeadlessRoute(pathname: string): HeadlessRoute | null {
  const segments = splitPath(pathname)
  if (!segments || segments.length < 5) return null
  if (segments[0] !== 'agent' || segments[2] !== 'headless') return null
  const action = segments[4]
  if (!action) return null
  return {
    agentId: segments[1],
    pageId: segments[3],
    action,
    target: segments.slice(5).join('/'),
  }
}

function parseRootRoute(pathname: string): RootRoute | null {
  const segments = splitPath(pathname)
  if (!segments || segments.length === 0) return null
  const [kind, ...rest] = segments
  const target = rest.join('/')
  if (kind === 'module') return target ? { kind, target } : null
  if (kind === 'asset') return target ? { kind, target } : null
  if (kind === 'file') return target ? { kind, target } : null
  if (kind === 'view') return target ? { kind: 'bare-file', target } : null
  return { kind: 'bare-file', target: segments.join('/') }
}

function splitPath(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
}

function encodePath(target: string): string {
  return target
    .replace(/^\/+/, '')
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

function toWebRequest(req: IncomingMessage, url: URL): Request {
  return new Request(url.toString(), {
    method: req.method || 'GET',
    headers: toWebHeaders(req.headers),
  })
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item)
    } else if (typeof value === 'string') {
      result.set(key, value)
    }
  }
  return result
}

async function writeWebResponse(res: ServerResponse, response: Response, headOnly: boolean): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  if (headOnly || !response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await once(res, 'drain')
      }
    }
  } finally {
    reader.releaseLock()
  }
  res.end()
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        rejected = true
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (!rejected) reject(err)
    })
  })
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sendHtml(res: ServerResponse, status: number, html: string, headOnly = false): void {
  sendText(res, status, html, 'text/html; charset=utf-8', headOnly)
}

function sendPlain(res: ServerResponse, status: number, body: string): void {
  sendText(res, status, body, 'text/plain; charset=utf-8')
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  headOnly = false,
): void {
  const bytes = Buffer.byteLength(body)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(bytes),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(headOnly ? undefined : body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, jsonReplacer)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  return value
}

function normalizeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: err.message || 'Unknown error' }
  }
  return { name: 'Error', message: String(err) }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
