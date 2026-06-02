// Bootstrap HTML/CSS/JS injected into every agent view. Single source of
// truth is shared/protocol/view-bootstrap.html — scripts/lib/generate-view-
// bootstrap.mjs codegens the TS constant during the build; the Rust mobile
// handler reads the same .html via include_str!.
import { VIEW_BOOTSTRAP_HTML } from './view-bootstrap.generated.js';

// Per-agent pseudo-DNS suffix. Each agent gets its own subdomain under this,
// which gives the view document a distinct origin (so storage/cookies are
// isolated in browser semantics, regardless of session). The suffix is
// non-resolvable on real DNS; Electron's session.protocol.handle('https',...)
// intercepts the request in-process. When views are later served from a real
// HTTPS server, only the hostname changes — views use root-relative paths so
// nothing inside them needs to change.
export const AGENT_VIEW_HOST_SUFFIX = '.views.agentwfy.local';

export function isAgentViewHostname(hostname: string): boolean {
  return hostname.endsWith(AGENT_VIEW_HOST_SUFFIX);
}

export type AgentPathKind = 'view' | 'file' | 'module' | 'asset';

export interface AgentPathInfo {
  kind: AgentPathKind;
  target: string;
}

// Parse an agent-view URL path (or a chat-link href) into kind + target.
// Accepts both `/view/foo` and `view/foo`; the leading slash is optional so
// agents can emit either form in markdown.
export function parseAgentPath(pathname: string): AgentPathInfo | null {
  const decoded = decodeURIComponent(pathname || '').trim();
  if (!decoded) return null;
  const stripped = decoded.replace(/^\/+/, '');
  const match = stripped.match(/^(view|file|module|asset)\/(.+)$/);
  if (!match) return null;
  const target = match[2].trim().replace(/^\/+/, '');
  if (!target) return null;
  return { kind: match[1] as AgentPathKind, target };
}

// View document requests carry `pageId` (set by buildTabSrc). Sub-resource
// fetches resolve relative to the view URL and never inherit query params, so
// pageId reliably distinguishes documents from data-dir asset fetches that
// happen to land under /view/...
export function isViewDocumentUrl(url: URL): boolean {
  const info = parseAgentPath(url.pathname);
  if (!info || info.kind !== 'view') return false;
  if (url.searchParams.has('pageId')) return true;
  // No pageId: only treat as a document if the target looks like a bare view
  // name (no path segments, no extension). Anything with `.` or `/` is a
  // sub-resource fetch.
  return !info.target.includes('/') && !info.target.includes('.');
}

export function buildViewDocument(content: string): string {
  return injectBootstrapIntoHtml(content, VIEW_BOOTSTRAP_HTML);
}

function injectBootstrapIntoHtml(source: string, bootstrap: string): string {
  if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, `${bootstrap}</head>`);
  }

  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/<body[^>]*>/i, (match) => `${match}${bootstrap}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${bootstrap}</head><body>${source}</body></html>`;
}
