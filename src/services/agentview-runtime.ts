const DEFAULT_SPECTRUM_BUNDLE_URLS = [
  'https://unpkg.com/@spectrum-web-components/bundle/elements.js?module',
  'https://cdn.jsdelivr.net/npm/@spectrum-web-components/bundle/elements.js/+esm',
];

function toScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function toJsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function normalizeSpectrumBundleUrls(urls: readonly string[] | undefined): string[] {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [...DEFAULT_SPECTRUM_BUNDLE_URLS];
  }

  const normalized = urls
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter((url) => url.length > 0);

  if (normalized.length === 0) {
    return [...DEFAULT_SPECTRUM_BUNDLE_URLS];
  }

  return Array.from(new Set(normalized));
}

function buildSharedBootstrapScript(viewId: string, spectrumBundleUrls: readonly string[]): string {
  const spectrumBundleUrlsLiteral = toJsonLiteral(spectrumBundleUrls);
  return `
<script>
  (() => {
    const spectrumBundleUrls = ${spectrumBundleUrlsLiteral};

    const loadSpectrumBundle = async () => {
      for (const url of spectrumBundleUrls) {
        try {
          await import(url);
          window.dispatchEvent(new CustomEvent('tradinglog:spectrum-ready', {
            detail: { url }
          }));
          return;
        } catch (error) {
          console.warn('[agentview] failed to load Spectrum bundle', url, error);
        }
      }

      window.dispatchEvent(new CustomEvent('tradinglog:spectrum-failed', {
        detail: { urls: spectrumBundleUrls.slice() }
      }));
    };

    void loadSpectrumBundle();

    const bridge = window.tradinglogViewBridge;
    if (!bridge) {
      console.error('[agentview] tradinglogViewBridge is unavailable');
      return;
    }

    if (typeof bridge.installRunSqlEventShim === 'function') {
      bridge.installRunSqlEventShim();
    }

    window.tradinglogView = {
      viewId: ${toScriptLiteral(viewId)},
      runSql: (request) => bridge.runSql(request),
      mediaUrl: (relativePath) => bridge.mediaUrl(relativePath),
    };

    window.dispatchEvent(new CustomEvent('tradinglog:view-runtime-ready', {
      detail: { viewId: ${toScriptLiteral(viewId)} }
    }));
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

function buildLegacyModuleDocument(moduleSource: string, viewId: string, spectrumBundleUrls: readonly string[]): string {
  const bootstrap = buildSharedBootstrapScript(viewId, spectrumBundleUrls);
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

export function resolveSpectrumBundleUrls(rawValue: string | undefined): string[] {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return [...DEFAULT_SPECTRUM_BUNDLE_URLS];
  }

  return normalizeSpectrumBundleUrls(rawValue.split(','));
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

export function buildViewDocument(
  viewId: string,
  content: string,
  options?: { spectrumBundleUrls?: readonly string[] }
): string {
  const spectrumBundleUrls = normalizeSpectrumBundleUrls(options?.spectrumBundleUrls);
  const bootstrap = buildSharedBootstrapScript(viewId, spectrumBundleUrls);
  if (looksLikeHtmlDocument(content)) {
    return injectBootstrapIntoHtml(content, bootstrap);
  }

  return buildLegacyModuleDocument(content, viewId, spectrumBundleUrls);
}
