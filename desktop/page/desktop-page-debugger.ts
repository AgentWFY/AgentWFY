import type { Event as ElectronEvent } from 'electron';
import type { Viewport } from '#shared/runtime/hosts.js';
import { PageCdpSubscriptionManager } from '#shared/page/cdp-subscription-manager.js';
import type { TabViewState } from './desktop-page-types.js';

interface DebuggerAttachment {
  messageHandler: (event: ElectronEvent, method: string, params: unknown, sessionId: string) => void;
  detachHandler: (event: ElectronEvent, reason: string) => void;
}

interface DesktopPageDebuggerDeps {
  resolveTabViewState: (tabId: string) => TabViewState;
  resolveReadyTabViewState: (tabId: string) => Promise<TabViewState>;
}

export class DesktopPageDebugger {
  private readonly deps: DesktopPageDebuggerDeps;
  private readonly attachments = new Map<string, DebuggerAttachment>();
  private readonly subscriptions = new PageCdpSubscriptionManager();

  constructor(deps: DesktopPageDebuggerDeps) {
    this.deps = deps;
  }

  applyHeadlessViewport(state: TabViewState, viewport: Viewport): void {
    try {
      this.ensureAttached(state);
    } catch (err) {
      console.warn(`[tabs] could not attach debugger to set headless viewport on "${state.tabId}":`, err);
      return;
    }
    state.view.webContents.debugger
      .sendCommand('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch((err: unknown) => {
        console.warn(`[tabs] setDeviceMetricsOverride failed for headless tab "${state.tabId}":`, err);
      });
  }

  async send(request: {
    tabId: string;
    method: string;
    params?: unknown;
    sessionId?: string;
  }): Promise<unknown> {
    const state = await this.deps.resolveReadyTabViewState(request.tabId);
    this.ensureAttached(state);
    const dbg = state.view.webContents.debugger;
    const params = (request.params ?? {}) as Record<string, unknown>;
    if (request.sessionId) {
      return dbg.sendCommand(request.method, params, request.sessionId);
    }
    return dbg.sendCommand(request.method, params);
  }

  subscribe(request: {
    tabId: string;
    subscriptionId: string;
    events: string[];
  }): void {
    const state = this.deps.resolveTabViewState(request.tabId);
    this.ensureAttached(state);
    this.subscriptions.subscribe({
      subscriptionId: request.subscriptionId,
      pageId: request.tabId,
      events: request.events,
    });
  }

  async poll(request: {
    subscriptionId: string;
    maxBatch?: number;
    maxWaitMs?: number;
  }): Promise<{ events: Array<{ method: string; params: unknown; sessionId?: string }>; dropped: number; closed: boolean }> {
    return this.subscriptions.poll(request.subscriptionId, {
      maxBatch: request.maxBatch,
      maxWaitMs: request.maxWaitMs,
    });
  }

  unsubscribe(subscriptionId: string): void {
    this.subscriptions.closeSubscription(subscriptionId);
  }

  detach(tabId: string): void {
    this.cleanupForTab(tabId);
  }

  cleanupForTab(tabId: string): void {
    this.subscriptions.closePage(tabId);

    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    this.attachments.delete(tabId);

    const state = this.tryResolveTabViewState(tabId);
    if (!state) return;
    const wc = state.view.webContents;
    if (wc.isDestroyed()) return;

    const dbg = wc.debugger;
    dbg.removeListener('message', attachment.messageHandler);
    dbg.removeListener('detach', attachment.detachHandler);
    if (dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (err) {
        console.warn(`[TabViewManager] debugger.detach failed for tab "${tabId}"`, err);
      }
    }
  }

  private ensureAttached(state: TabViewState): void {
    const tabId = state.tabId;
    if (this.attachments.has(tabId)) {
      return;
    }

    const dbg = state.view.webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
    }

    const messageHandler = (
      _event: ElectronEvent,
      method: string,
      params: unknown,
      sessionId: string,
    ) => {
      this.subscriptions.pushEvent(tabId, { method, params, sessionId: sessionId || undefined });
    };

    const detachHandler = (_event: ElectronEvent, reason: string) => {
      console.warn(`[TabViewManager] debugger detached from tab "${tabId}": ${reason}`);
      this.cleanupForTab(tabId);
    };

    dbg.on('message', messageHandler);
    dbg.on('detach', detachHandler);
    this.attachments.set(tabId, { messageHandler, detachHandler });
  }

  private tryResolveTabViewState(tabId: string): TabViewState | null {
    try {
      return this.deps.resolveTabViewState(tabId);
    } catch {
      return null;
    }
  }
}
