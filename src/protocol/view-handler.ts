import { net } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { isInsideDir, assertPathAllowed } from '../security/path-policy.js';
import { serveFile } from './file-server.js';
import { buildViewDocument, parseViewName, normalizeViewPathname, isViewDocumentRequest, isViewHostname, isFileHostname, isModuleHostname } from './view-document.js';
import { getViewContent } from '../db/views.js';
import { getModuleContent, getModuleContentType } from '../db/modules.js';

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

async function resolveViewDataPath(url: URL, agentRoot: string): Promise<string> {
  const normalizedPath = normalizeViewPathname(url.pathname);
  if (!normalizedPath) {
    throw new Error('Missing file path');
  }

  return assertPathAllowed(agentRoot, normalizedPath, { allowMissing: false });
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
  agentRoot: string;
  clientPath: string;
}

export function createViewProtocolHandler(options: ViewProtocolHandlerOptions): (request: Request) => Promise<Response> {
  const { agentRoot, clientPath } = options;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { hostname } = url;

    if (hostname === 'asset') {
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

    if (isModuleHostname(hostname)) {
      const moduleName = normalizeViewPathname(url.pathname);
      if (!moduleName) {
        return new Response('Missing module name', {
          status: 400,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      let record;
      try {
        record = await getModuleContent(agentRoot, moduleName);
      } catch (error: unknown) {
        console.error('[agentview] failed to read module from agent DB', error);
        return new Response((error as Error)?.message || 'Failed to load module', {
          status: 500,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      if (!record) {
        return new Response(`Module not found: ${moduleName}`, {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      return new Response(record.content, {
        status: 200,
        headers: {
          'Content-Type': getModuleContentType(record.name),
          'Cache-Control': 'no-store',
        },
      });
    }

    if (isFileHostname(hostname) || (isViewHostname(hostname) && !isViewDocumentRequest(url))) {
      try {
        const absolutePath = await resolveViewDataPath(url, agentRoot);
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

    if (!isViewHostname(hostname)) {
      return new Response('Unsupported agentview route', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    let viewName: string;
    try {
      viewName = parseViewName(url);
    } catch (error: unknown) {
      return toHtmlResponse(400, `<pre>${escapeHtml((error as Error)?.message || 'Invalid agent view URL')}</pre>`);
    }

    // File-sourced view: read from filesystem instead of DB
    if (url.searchParams.get('source') === 'file') {
      try {
        const absolutePath = await assertPathAllowed(agentRoot, viewName, { allowMissing: false });
        const content = await readFile(absolutePath, 'utf-8');
        const html = buildViewDocument(content);
        return toHtmlResponse(200, html);
      } catch (error: unknown) {
        console.error('[agentview] failed to read file view', error);
        return toHtmlResponse(404, `<pre>File not found: ${escapeHtml(viewName)}</pre>`);
      }
    }

    let record;
    try {
      record = await getViewContent(agentRoot, viewName);
    } catch (error: unknown) {
      console.error('[agentview] failed to read view from agent DB', error);
      return toHtmlResponse(500, `<pre>${escapeHtml((error as Error)?.message || 'Failed to load view')}</pre>`);
    }

    if (!record) {
      return toHtmlResponse(404, `<pre>View not found: ${escapeHtml(viewName)}</pre>`);
    }

    const html = buildViewDocument(record.content);
    return toHtmlResponse(200, html);
  };
}
