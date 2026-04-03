function buildSharedBootstrapScript(): string {
  return `
<style id="agentview-design-tokens">
  :root {
    color-scheme: light dark;

    /* Typography */
    --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;

    /* Layout constants */
    --radius-sm: 4px;
    --radius-md: 6px;

    /* Timing */
    --transition-fast: 120ms ease;
    --transition-normal: 200ms ease-out;

    /* Light mode (default) */
    --color-bg1: #ffffff;
    --color-bg2: #f8f8f8;
    --color-bg3: #f0f0f0;
    --color-surface: #ffffff;

    --color-border: #e0e0e0;
    --color-divider: #d0d0d0;

    --color-text1: #6b6b6b;
    --color-text2: #999999;
    --color-text3: #444444;
    --color-text4: #1a1a1a;
    --color-placeholder: #b0b0b0;

    --color-accent: #1a6fb5;
    --color-accent-hover: #2080cc;
    --color-focus-border: #1a6fb5;

    --color-red-bg: #fdf0f0;
    --color-red-fg: #c62828;

    --color-green-bg: #f0fdf4;
    --color-green-fg: #2e7d32;

    --color-yellow-bg: #fffde7;
    --color-yellow-fg: #f57f17;

    --color-selection-bg: #1a6fb5;
    --color-selection-fg: #ffffff;
    --color-item-hover: rgba(0, 0, 0, 0.05);

    --color-input-bg: #ffffff;
    --color-input-border: #d0d0d0;

    --color-code-bg: #f5f5f5;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg1: #1e1e1e;
      --color-bg2: #252526;
      --color-bg3: #1a1a1a;
      --color-surface: #2d2d2d;

      --color-border: #3d3d3d;
      --color-divider: #4a4a4a;

      --color-text1: #b0b0b0;
      --color-text2: #808080;
      --color-text3: #cccccc;
      --color-text4: #e0e0e0;
      --color-placeholder: #666666;

      --color-accent: #2b7ab5;
      --color-accent-hover: #3994d4;
      --color-focus-border: #2b7ab5;

      --color-red-bg: #3a1515;
      --color-red-fg: #ff6b6b;

      --color-green-bg: #1a3a1f;
      --color-green-fg: #4caf50;

      --color-yellow-bg: #3a3015;
      --color-yellow-fg: #ffb74d;

      --color-item-hover: rgba(255, 255, 255, 0.05);

      --color-input-bg: #1a1a1a;
      --color-input-border: #3d3d3d;

      --color-code-bg: #1a1a1a;
    }
  }

  /* Base reset */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; font-family: var(--font-family); color: var(--color-text3); background: var(--color-bg1); }
</style>
<style id="agentview-initial-guard">
  html:not([data-agentview-ready="1"]),
  html:not([data-agentview-ready="1"]) body {
    visibility: hidden !important;
  }
</style>
<script>
  (() => {
    const root = document.documentElement;
    root.dataset.agentviewReady = '0';

    let presented = false;
    let revealFallbackTimer = 0;

    const presentView = () => {
      if (presented) {
        return;
      }

      presented = true;
      if (revealFallbackTimer) {
        window.clearTimeout(revealFallbackTimer);
        revealFallbackTimer = 0;
      }
      root.dataset.agentviewReady = '1';
    };

    revealFallbackTimer = window.setTimeout(presentView, 5000);

    window.requestAnimationFrame(presentView);
  })();
</script>
`;
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

export function isViewHostname(hostname: string): boolean {
  return hostname === 'view' || (hostname.startsWith('a') && hostname.endsWith('.view') && hostname.indexOf('.') > 0);
}

export function isFileHostname(hostname: string): boolean {
  return hostname === 'file' || (hostname.startsWith('a') && hostname.endsWith('.file') && hostname.indexOf('.') > 0);
}

export function parseAgentHash(hostname: string): string | null {
  const dotIndex = hostname.indexOf('.');
  if (dotIndex > 0 && hostname.startsWith('a')) {
    const hash = hostname.slice(1, dotIndex);
    return hash.length > 0 ? hash : null;
  }
  return null;
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
  const bootstrap = buildSharedBootstrapScript();
  return injectBootstrapIntoHtml(content, bootstrap);
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
