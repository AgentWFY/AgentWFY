import type { BrowserWindow } from 'electron';

export interface RendererBridgeDeps {
  getMainWindow: () => BrowserWindow | null;
}

export class RendererBridge {
  private readonly getMainWindow: () => BrowserWindow | null;

  constructor(deps: RendererBridgeDeps) {
    this.getMainWindow = deps.getMainWindow;
  }

  emitTabViewEvent(
    tabId: string,
    type: 'did-start-loading' | 'did-stop-loading' | 'did-fail-load',
    detail?: { errorCode?: number; errorDescription?: string }
  ): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }

    win.webContents.send('tabs:viewEvent', {
      tabId,
      type,
      ...(detail || {}),
    });
  }

  focusMainRendererWindow(): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }

    try {
      if (!win.isFocused()) {
        win.focus();
      }
      win.webContents.focus();
    } catch (error) {
      console.warn('[agent-runtime] failed to focus renderer window', error);
    }
  }

  static toSafeJsonLiteral(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  dispatchRendererCustomEvent(eventName: string, detail?: unknown): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }

    this.focusMainRendererWindow();
    const serializedName = JSON.stringify(eventName);
    const eventInit = typeof detail === 'undefined'
      ? ''
      : `, { detail: ${RendererBridge.toSafeJsonLiteral(detail)} }`;

    void win.webContents.executeJavaScript(`
      window.dispatchEvent(new CustomEvent(${serializedName}${eventInit}));
    `, true).catch((error) => {
      console.warn(`[agent-runtime] failed to dispatch renderer event ${eventName}`, error);
    });
  }

  dispatchRendererWindowEvent(eventName: string): void {
    this.dispatchRendererCustomEvent(eventName);
  }
}
