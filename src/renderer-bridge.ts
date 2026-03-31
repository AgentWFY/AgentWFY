import type { BaseWindow, WebContents } from 'electron';

interface RendererBridgeDeps {
  getMainWindow: () => BaseWindow | null;
  getRendererWebContents: () => WebContents | null;
}

export class RendererBridge {
  private readonly getMainWindow: () => BaseWindow | null;
  private readonly getRendererWebContents: () => WebContents | null;

  constructor(deps: RendererBridgeDeps) {
    this.getMainWindow = deps.getMainWindow;
    this.getRendererWebContents = deps.getRendererWebContents;
  }

  emitTabViewEvent(
    tabId: string,
    type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load',
    detail?: { errorCode?: number; errorDescription?: string }
  ): void {
    const wc = this.getRendererWebContents();
    if (!wc || wc.isDestroyed()) {
      return;
    }

    wc.send('tabs:viewEvent', {
      tabId,
      type,
      ...(detail || {}),
    });
  }

  focusMainRendererWindow(): void {
    const win = this.getMainWindow();
    const wc = this.getRendererWebContents();
    if (!win || win.isDestroyed()) {
      return;
    }

    try {
      if (!win.isFocused()) {
        win.focus();
      }
      wc?.focus();
    } catch (error) {
      console.warn('[agent-runtime] failed to focus renderer window', error);
    }
  }

  static toSafeJsonLiteral(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  dispatchRendererCustomEvent(eventName: string, detail?: unknown): void {
    const wc = this.getRendererWebContents();
    if (!wc || wc.isDestroyed()) {
      return;
    }

    const serializedName = JSON.stringify(eventName);
    const eventInit = typeof detail === 'undefined'
      ? ''
      : `, { detail: ${RendererBridge.toSafeJsonLiteral(detail)} }`;

    void wc.executeJavaScript(`
      window.dispatchEvent(new CustomEvent(${serializedName}${eventInit}));
    `, true).catch((error) => {
      console.warn(`[agent-runtime] failed to dispatch renderer event ${eventName}`, error);
    });
  }

  dispatchRendererWindowEvent(eventName: string): void {
    this.dispatchRendererCustomEvent(eventName);
  }
}
