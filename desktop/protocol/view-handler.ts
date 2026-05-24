import { net } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { isInsideDir } from '#shared/security/path-policy.js';
import { buildViewDocument, parseAgentPath, isViewDocumentUrl } from '#shared/protocol/view-document.js';
import { getViewContent } from '#shared/db/views.js';
import { getModuleContent, getModuleContentType } from '#shared/db/modules.js';
import type { FileSource } from './file-source.js';

function resolveViewAssetPath(relativePath: string, clientPath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    return null;
  }

  const normalizedRelativePath = relativePath.replace(/^\/+/, '').trim();
  if (normalizedRelativePath.length === 0) {
    return null;
  }

  // Restrict /asset/* to bundled client assets only.
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

function notFound(message: string): Response {
  return new Response(message, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export interface ViewProtocolHandlerOptions {
  cacheRoot: string;
  clientPath: string;
  fileSource: FileSource;
}

// Handles a request whose hostname is already known to match this agent's
// subdomain. Returns the response for /view/, /module/, /file/, /asset/ paths
// under the agent's pseudo-host.
export function createViewProtocolHandler(options: ViewProtocolHandlerOptions): (request: Request, url: URL) => Promise<Response> {
  const { cacheRoot, clientPath, fileSource } = options;

  return async (request: Request, url: URL): Promise<Response> => {
    const info = parseAgentPath(url.pathname);
    if (!info) {
      return notFound('Unsupported agent-view route');
    }

    if (info.kind === 'asset') {
      const assetPath = resolveViewAssetPath(info.target, clientPath);
      if (!assetPath) return notFound('Asset not found');
      return net.fetch(pathToFileURL(assetPath).toString());
    }

    if (info.kind === 'module') {
      let record;
      try {
        record = await getModuleContent(cacheRoot, info.target);
      } catch (error: unknown) {
        console.error('[agent-view] failed to read module from agent DB', error);
        return new Response((error as Error)?.message || 'Failed to load module', {
          status: 500,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      if (!record) return notFound(`Module not found: ${info.target}`);

      return new Response(record.content, {
        status: 200,
        headers: {
          'Content-Type': getModuleContentType(record.name),
          'Cache-Control': 'no-store',
        },
      });
    }

    // Sub-resource fetches that landed under /view/... resolve against the
    // agent's data dir, matching how /file/... works.
    if (info.kind === 'file' || (info.kind === 'view' && !isViewDocumentUrl(url))) {
      try {
        return await fileSource.serve(request, info.target);
      } catch {
        return notFound('Asset not found');
      }
    }

    // info.kind === 'view' and isViewDocumentUrl(url)
    if (url.searchParams.get('source') === 'file') {
      try {
        const content = await fileSource.readText(info.target);
        return toHtmlResponse(200, buildViewDocument(content));
      } catch (error: unknown) {
        console.error('[agent-view] failed to read file view', error);
        return toHtmlResponse(404, `<pre>File not found: ${escapeHtml(info.target)}</pre>`);
      }
    }

    let record;
    try {
      record = await getViewContent(cacheRoot, info.target);
    } catch (error: unknown) {
      console.error('[agent-view] failed to read view from agent DB', error);
      return toHtmlResponse(500, `<pre>${escapeHtml((error as Error)?.message || 'Failed to load view')}</pre>`);
    }

    if (!record) return toHtmlResponse(404, `<pre>View not found: ${escapeHtml(info.target)}</pre>`);
    return toHtmlResponse(200, buildViewDocument(record.content));
  };
}
