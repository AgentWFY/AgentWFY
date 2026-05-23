// Bootstrap HTML/CSS/JS injected into every agent view. Single source of
// truth is shared/protocol/view-bootstrap.html — scripts/lib/generate-view-
// bootstrap.mjs codegens the TS constant during the build; the Rust mobile
// handler reads the same .html via include_str!.
import { VIEW_BOOTSTRAP_HTML } from './view-bootstrap.generated.js';

function injectBootstrapIntoHtml(source: string, bootstrap: string): string {
  if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, `${bootstrap}</head>`);
  }

  if (/<body[^>]*>/i.test(source)) {
    return source.replace(/<body[^>]*>/i, (match) => `${match}${bootstrap}`);
  }

  return `<!doctype html><html><head><meta charset="utf-8">${bootstrap}</head><body>${source}</body></html>`;
}

export function isViewHostname(hostname: string): boolean {
  return hostname === 'view';
}

export function isFileHostname(hostname: string): boolean {
  return hostname === 'file';
}

export function isModuleHostname(hostname: string): boolean {
  return hostname === 'module';
}

export function parseViewName(url: URL): string {
  if (!isViewHostname(url.hostname)) {
    throw new Error(`Unsupported view route: ${url.hostname}`);
  }

  const rawPath = decodeURIComponent(url.pathname || '');
  const normalized = rawPath.replace(/^\/+/, '').trim();
  if (normalized.length === 0) {
    throw new Error('Missing view name');
  }

  return normalized;
}

export function buildViewDocument(content: string): string {
  return injectBootstrapIntoHtml(content, VIEW_BOOTSTRAP_HTML);
}

export function normalizeViewPathname(pathname: string): string {
  const decoded = decodeURIComponent(pathname || '');
  return decoded.replace(/^\/+/, '').trim();
}

export function isViewDocumentRequest(url: URL): boolean {
  if (!isViewHostname(url.hostname)) {
    return false;
  }

  const normalizedPath = normalizeViewPathname(url.pathname);
  if (!normalizedPath) {
    return false;
  }

  // View document URLs always carry a tabId param (used by tab tracking in
  // TabViewManager.parseTrackedViewFromUrl). Sub-resource fetches (images, scripts)
  // resolve relative to the view URL and never inherit query params, so tabId
  // reliably distinguishes view documents from data-dir file assets.
  if (url.searchParams.has('tabId')) {
    return true;
  }

  // Treat paths that look like files (contains "/" or extension) as data-dir assets.
  if (normalizedPath.includes('/') || normalizedPath.includes('.')) {
    return false;
  }

  return true;
}

// Coerce agent-supplied URL strings to the canonical `agentview://view|file/...`
// shape. Agents occasionally invent the scheme (`agentwfy://`) or pluralize
// the host (`views`/`files`); both normally make tab-open silently fail.
export function normalizeAgentViewUrl(href: string): URL | null {
  const normalized = href.startsWith('agentwfy://')
    ? 'agentview://' + href.slice('agentwfy://'.length)
    : href;
  if (!normalized.startsWith('agentview://')) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (url.hostname === 'views') url.hostname = 'view';
  else if (url.hostname === 'files') url.hostname = 'file';
  return url;
}
