import { net } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { isInsideDir, assertPathAllowed } from '../security/path-policy.js';
import { serveFile } from './file-server.js';
import { buildViewDocument, parseViewId, normalizeViewPathname, isViewDocumentRequest } from './view-document.js';
import { getViewById } from '../db/views.js';

function resolveViewAssetPath(relativePath: string, clientPath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return null;
  }

  const normalizedRelativePath = relativePath.replace(/^\/+/, '').trim();
  if (normalizedRelativePath.length === 0) {
    return null;
  }

  // Restrict agentview://asset/* to bundled client assets only.
  if (!normalizedRelativePath.startsWith('assets/')) {
    return null;
  }

  const clientDir = path.dirname(clientPath);
  const absolutePath = path.resolve(clientDir, normalizedRelativePath);
  if (!isInsideDir(clientDir, absolutePath)) {
    return null;
  }

  return absolutePath;
}

async function resolveViewDataPath(url: URL, getDataDir: () => string): Promise<string> {
  const normalizedPath = normalizeViewPathname(url.pathname);
  if (!normalizedPath) {
    throw new Error('Missing file path');
  }

  return assertPathAllowed(getDataDir(), normalizedPath, { allowMissing: false });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toHtmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export interface ViewProtocolHandlerOptions {
  getDataDir: () => string;
  clientPath: string;
}

export function createViewProtocolHandler(options: ViewProtocolHandlerOptions): (request: Request) => Promise<Response> {
  const { getDataDir, clientPath } = options;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname === 'asset') {
      const assetPath = resolveViewAssetPath(decodeURIComponent(url.pathname || ''), clientPath);
      if (!assetPath) {
        return new Response('Asset not found', {
          status: 404,
          headers: {
            'Cache-Control': 'no-store',
          },
        });
      }

      return net.fetch(pathToFileURL(assetPath).toString());
    }

    if (url.hostname === 'file' || (url.hostname === 'view' && !isViewDocumentRequest(url))) {
      try {
        const absolutePath = await resolveViewDataPath(url, getDataDir);
        return serveFile(request, absolutePath);
      } catch {
        return new Response('Asset not found', {
          status: 404,
          headers: {
            'Cache-Control': 'no-store',
          },
        });
      }
    }

    if (url.hostname !== 'view') {
      return new Response('Unsupported agentview route', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    let viewId: string;
    try {
      viewId = parseViewId(url);
    } catch (error: unknown) {
      return toHtmlResponse(400, `<pre>${escapeHtml((error as Error)?.message || 'Invalid agent view URL')}</pre>`);
    }

    const dataDir = getDataDir();

    // File-sourced view: read from filesystem instead of DB
    if (url.searchParams.get('source') === 'file') {
      try {
        const absolutePath = await assertPathAllowed(dataDir, viewId, { allowMissing: false });
        const content = await readFile(absolutePath, 'utf-8');
        const html = buildViewDocument(content);
        return toHtmlResponse(200, html);
      } catch (error: unknown) {
        console.error('[agentview] failed to read file view', error);
        return toHtmlResponse(404, `<pre>File not found: ${escapeHtml(viewId)}</pre>`);
      }
    }

    let record;
    try {
      record = await getViewById(dataDir, viewId);
    } catch (error: unknown) {
      console.error('[agentview] failed to read view from agent DB', error);
      return toHtmlResponse(500, `<pre>${escapeHtml((error as Error)?.message || 'Failed to load view')}</pre>`);
    }

    if (!record) {
      return toHtmlResponse(404, `<pre>View not found: ${escapeHtml(viewId)}</pre>`);
    }

    const html = buildViewDocument(record.content);
    return toHtmlResponse(200, html);
  };
}
