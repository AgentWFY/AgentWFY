import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { assertPathAllowed } from '../security/path-policy.js';
import { mimeFromExt } from './handlers.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export interface HttpRequestData {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string>;
  body: unknown;
}

type RouteHandler = (request: HttpRequestData) => Promise<{ status?: number; body: unknown }>;

interface RegisteredRoute {
  handler: RouteHandler;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

function routeKey(routePath: string, method: string): string {
  return `${method.toUpperCase()}:${routePath}`;
}

export interface HttpApiServer {
  server: http.Server;
  port(): number;
  close(): Promise<void>;
  registerRoute(routePath: string, method: string, handler: RouteHandler): void;
  unregisterRoute(routePath: string, method: string): void;
}

interface HttpApiDeps {
  getAgentRoot: () => string;
  preferredPort: number;
}

function createRequestHandler(
  routes: Map<string, RegisteredRoute>,
  deps: { getAgentRoot: () => string },
): http.RequestListener {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // GET /files/* — file serving
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/files/'.length));
      if (!relativePath) {
        jsonResponse(res, 400, { error: 'Missing file path' });
        return;
      }

      let filePath: string;
      try {
        filePath = await assertPathAllowed(deps.getAgentRoot(), relativePath);
      } catch (e: unknown) {
        jsonResponse(res, 403, { error: (e as Error).message });
        return;
      }

      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        jsonResponse(res, 404, { error: 'File not found' });
        return;
      }

      if (!stat.isFile()) {
        jsonResponse(res, 400, { error: 'Not a file' });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeFromExt(ext);

      try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Content-Length': data.length,
        });
        res.end(data);
      } catch {
        jsonResponse(res, 500, { error: 'Failed to read file' });
      }
      return;
    }

    // Dynamic route matching
    const method = (req.method || 'GET').toUpperCase();
    const key = routeKey(url.pathname, method);
    const route = routes.get(key);

    if (!route) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    // Read body
    let rawBody = '';
    try {
      rawBody = await readBody(req);
    } catch (e: unknown) {
      jsonResponse(res, 413, { error: (e as Error).message });
      return;
    }

    let parsedBody: unknown = rawBody;
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' });
        return;
      }
    }

    // Build query object
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) {
      query[k] = v;
    }

    // Build headers object
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }

    const requestData: HttpRequestData = {
      method,
      path: url.pathname,
      headers,
      query,
      body: parsedBody,
    };

    try {
      const result = await route.handler(requestData);
      jsonResponse(res, result.status ?? 200, result.body);
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: (e as Error).message });
    }
  };
}

function listenOnPort(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startHttpApi(deps: HttpApiDeps): Promise<HttpApiServer> {
  const routes = new Map<string, RegisteredRoute>();

  const registerRoute: HttpApiServer['registerRoute'] = (routePath, method, handler) => {
    const key = routeKey(routePath, method);
    if (routes.has(key)) {
      console.warn(`[http-api] Overwriting existing route: ${key}`);
    }
    routes.set(key, { handler });
  };

  const unregisterRoute: HttpApiServer['unregisterRoute'] = (routePath, method) => {
    routes.delete(routeKey(routePath, method));
  };

  const server = http.createServer(createRequestHandler(routes, deps));

  let actualPort: number;
  try {
    actualPort = await listenOnPort(server, deps.preferredPort);
    console.log(`[http-api] listening on http://127.0.0.1:${actualPort}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.warn(`[http-api] port ${deps.preferredPort} in use, falling back to OS-assigned port`);
      actualPort = await listenOnPort(server, 0);
      console.log(`[http-api] listening on http://127.0.0.1:${actualPort} (fallback)`);
    } else {
      throw err;
    }
  }

  return {
    server,
    port: () => actualPort,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    }),
    registerRoute,
    unregisterRoute,
  };
}
