import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { storeGet, storeSet } from '../ipc/store.js';
import { assertPathAllowed } from '../security/path-policy.js';
import { createMethodRegistry, mimeFromExt } from './handlers.js';
import type { OnDbChange } from '../db/sqlite.js';

const DEFAULT_PORT = 9877;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

interface HttpApiDeps {
  getDataDir: () => string;
  onDbChange: OnDbChange;
  startTask: (taskId: number) => Promise<{ runId: string }>;
  busPublish: (topic: string, data: unknown) => void;
}

function ensureApiKey(): string {
  const existing = storeGet('httpApi.apiKey');
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const key = crypto.randomUUID();
  storeSet('httpApi.apiKey', key);
  return key;
}

function getPort(): number {
  const port = storeGet('httpApi.port');
  return typeof port === 'number' ? port : DEFAULT_PORT;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function startHttpApi(deps: HttpApiDeps): http.Server {
  const apiKey = ensureApiKey();

  const methods = createMethodRegistry(deps);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // POST /rpc
    if (req.method === 'POST' && url.pathname === '/rpc') {
      // Auth check
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token || token !== apiKey) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch (e: unknown) {
        jsonResponse(res, 413, { error: (e as Error).message });
        return;
      }

      let parsed: { method?: string; params?: Record<string, unknown> };
      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const methodName = parsed.method;
      if (typeof methodName !== 'string' || !methods[methodName]) {
        jsonResponse(res, 400, { error: `Unknown method: "${methodName}"` });
        return;
      }

      const params = (parsed.params && typeof parsed.params === 'object') ? parsed.params as Record<string, unknown> : {};

      try {
        const result = await methods[methodName](params);
        jsonResponse(res, 200, { ok: true, data: result });
      } catch (e: unknown) {
        jsonResponse(res, 200, { error: (e as Error).message });
      }
      return;
    }

    // GET /files/*
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      // Auth via query param
      const key = url.searchParams.get('key');
      if (!key || key !== apiKey) {
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }

      const relativePath = decodeURIComponent(url.pathname.slice('/files/'.length));
      if (!relativePath) {
        jsonResponse(res, 400, { error: 'Missing file path' });
        return;
      }

      let filePath: string;
      try {
        filePath = await assertPathAllowed(deps.getDataDir(), relativePath);
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

    jsonResponse(res, 404, { error: 'Not found' });
  });

  const port = getPort();
  server.listen(port, '127.0.0.1', () => {
    console.log(`[http-api] listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[http-api] port ${port} is already in use, HTTP API disabled`);
    } else {
      console.error(`[http-api] server error:`, err);
    }
  });

  return server;
}
