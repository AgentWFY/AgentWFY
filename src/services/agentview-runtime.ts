function toScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildSharedBootstrapScript(viewId: string): string {
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
    const currentViewId = ${toScriptLiteral(viewId)};
    const root = document.documentElement;
    root.dataset.agentviewReady = '0';

    let presented = false;
    let revealFallbackTimer = 0;

    const presentView = (reason) => {
      if (presented) {
        return;
      }

      presented = true;
      if (revealFallbackTimer) {
        window.clearTimeout(revealFallbackTimer);
        revealFallbackTimer = 0;
      }
      root.dataset.agentviewReady = '1';
      window.dispatchEvent(new CustomEvent('agentwfy:view-presented', {
        detail: {
          viewId: currentViewId,
          reason,
        }
      }));
    };

    revealFallbackTimer = window.setTimeout(() => {
      presentView('timeout');
    }, 5000);

    window.requestAnimationFrame(() => {
      presentView('ready');
    });
  })();
</script>
`;
}

function looksLikeHtmlDocument(source: string): boolean {
  const trimmed = source.trimStart();
  if (trimmed.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    lower.startsWith('<head') ||
    lower.startsWith('<body')
  ) {
    return true;
  }

  // Accept HTML fragments (for example "<div>...</div>") stored in DB.
  return trimmed.startsWith('<');
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

function buildLegacyModuleDocument(moduleSource: string, viewId: string): string {
  const bootstrap = buildSharedBootstrapScript(viewId);
  const encodedSource = toScriptLiteral(moduleSource);
  const encodedViewId = toScriptLiteral(viewId);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: auto; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  </style>
  ${bootstrap}
</head>
<body>
  <script type="module">
    const source = ${encodedSource};
    const blob = new Blob([source], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    const showError = (message) => {
      const pre = document.createElement('pre');
      pre.textContent = message;
      pre.style.cssText = 'margin:16px;padding:12px;border:1px solid #f99;background:#2b1f1f;color:#ffdcdc;white-space:pre-wrap;';
      document.body.appendChild(pre);
    };

    try {
      const mod = await import(blobUrl);
      let Component = null;
      for (const exported of Object.values(mod)) {
        if (typeof exported === 'function' && exported.metadata) {
          Component = exported;
          break;
        }
      }

      if (!Component) {
        throw new Error('No component with static metadata found in agent view module');
      }

      const tagName = 'agent-runtime-view-' + Math.random().toString(36).slice(2);
      customElements.define(tagName, Component);

      const instance = document.createElement(tagName);
      instance.setAttribute('view-id', ${encodedViewId});
      instance.style.cssText = 'display:block;width:100%;height:100%;min-height:0;';
      document.body.appendChild(instance);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      showError('[agentview] failed to load legacy module\\n' + message);
      console.error('[agentview] failed to load legacy module', error);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  </script>
</body>
</html>`;
}

export function parseAgentViewId(url: URL): string {
  if (url.hostname !== 'view') {
    throw new Error(`Unsupported agentview route: ${url.hostname}`);
  }

  const rawPath = decodeURIComponent(url.pathname || '');
  const normalized = rawPath.replace(/^\/+/, '').trim();
  if (normalized.length === 0) {
    throw new Error('Missing view id');
  }

  return normalized;
}

export function buildViewDocument(viewId: string, content: string): string {
  const bootstrap = buildSharedBootstrapScript(viewId);
  if (looksLikeHtmlDocument(content)) {
    return injectBootstrapIntoHtml(content, bootstrap);
  }

  return buildLegacyModuleDocument(content, viewId);
}
