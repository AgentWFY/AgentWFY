import type { PageHandle } from '#shared/page/page-handle.js';
import type { PageHost, PageHostOpenRequest, PageOpenContext } from '#shared/page/page-host.js';
import {
  type PageCdpSubscription,
  type PageCloseAfterIdleMs,
  type PageConsoleLog,
  type PageHostInfo,
  type PageInputRequest,
  type OpenPageRequest,
  type PageHostKind,
  type PageScreenshot,
  type PageSource,
  type PageViewportInput,
} from '#shared/page/types.js';
import { pageSourceParams } from '#shared/page/page-source.js';
import type { TabViewManager } from '../tab-view-manager.js';
import type { TabData } from './desktop-page-types.js';

export class DesktopPageHost implements PageHost {
  readonly hostKind: PageHostKind;
  protected readonly manager: TabViewManager;
  protected readonly agentId: string;
  protected readonly headless: boolean;

  constructor(manager: TabViewManager, options: {
    agentId: string
    hostKind?: PageHostKind
    headless?: boolean
  }) {
    this.manager = manager;
    this.agentId = options.agentId;
    this.hostKind = options.hostKind ?? 'desktop';
    this.headless = options.headless ?? false;
  }

  canOpen(_request: OpenPageRequest, context: PageOpenContext): boolean {
    return context.client === !this.headless;
  }

  async openPage(request: PageHostOpenRequest): Promise<PageHandle> {
    const result = await this.manager.openPageView({
      pageId: request.pageId,
      source: request.source,
      title: request.title,
      headless: this.headless,
      viewport: request.viewport as PageViewportInput | undefined,
      width: request.width,
      height: request.height,
      closeAfterIdleMs: request.closeAfterIdleMs as PageCloseAfterIdleMs | undefined,
      params: pageSourceParams(request.source),
      select: !this.headless,
    });
    const handle = await this.getPage(result.pageId);
    if (!handle) {
      throw new Error(`Failed to create desktop page "${result.pageId}"`);
    }
    return handle;
  }

  async getPage(pageId: string): Promise<PageHandle | null> {
    const tab = this.manager.getTabData(pageId);
    if (!tab || Boolean(tab.headless) !== this.headless) return null;
    return new DesktopPageHandle(this.manager, this, tab);
  }

  async getCurrentClientPage(): Promise<PageHostInfo | null> {
    if (this.headless) return null;
    const tab = await this.manager.getCurrentTabHandler();
    return tab ? this.pageInfoFromTab(tab) : null;
  }

  async listPages(): Promise<PageHostInfo[]> {
    const tabs = await this.manager.getTabsHandler();
    return tabs
      .filter(tab => Boolean(tab.headless) === this.headless)
      .map(tab => this.pageInfoFromTab(tab));
  }

  pageInfoFromTab(tab: TabData): PageHostInfo {
    return {
      pageId: tab.tabId || tab.id,
      title: tab.title || '',
      source: sourceFromTab(tab),
      headless: Boolean(tab.headless),
      ...(tab.viewport ? { viewport: tab.viewport } : {}),
      ...(typeof tab.viewUpdatedAt === 'number' ? { version: tab.viewUpdatedAt } : {}),
      ...(tab.closeAfterIdleMs ? { closeAfterIdleMs: tab.closeAfterIdleMs } : {}),
    };
  }
}

export class DesktopPageHandle implements PageHandle {
  readonly pageId: string;

  constructor(
    private readonly manager: TabViewManager,
    private readonly host: DesktopPageHost,
    private tab: TabData,
  ) {
    this.pageId = tab.tabId || tab.id;
  }

  info(): PageHostInfo {
    return this.host.pageInfoFromTab(this.tab);
  }

  async close(): Promise<void> {
    await this.manager.closeTabHandler({ tabId: this.pageId, force: true });
  }

  async reload(): Promise<void> {
    await this.manager.reloadTabHandler({ tabId: this.pageId });
    await this.refresh();
  }

  async capture(): Promise<PageScreenshot> {
    const result = await this.manager.captureTabById({ tabId: this.pageId });
    await this.refresh();
    return {
      ...result,
      pageId: this.pageId,
      capturedPageId: this.pageId,
    };
  }

  async runJs(code: string, timeoutMs?: number): Promise<unknown> {
    const result = await this.manager.execTabJsById({ tabId: this.pageId, code, timeoutMs });
    await this.refresh();
    return result;
  }

  async sendInput(input: PageInputRequest): Promise<void> {
    await this.manager.sendInputById({
      tabId: this.pageId,
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button,
      clickCount: input.clickCount,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      keyCode: input.keyCode,
      modifiers: input.modifiers,
    });
    await this.refresh();
  }

  async inspectElement(selector: string): Promise<unknown> {
    const result = await this.manager.inspectElementById({ tabId: this.pageId, selector });
    await this.refresh();
    return result;
  }

  async getConsoleLogs(request?: { since?: number; limit?: number }): Promise<PageConsoleLog[]> {
    await this.refresh();
    return this.manager.getTabConsoleLogsById({
      tabId: this.pageId,
      since: request?.since,
      limit: request?.limit,
    });
  }

  async sendCdp(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const result = await this.manager.tabDebuggerSendById({
      tabId: this.pageId,
      method,
      params,
      sessionId,
    });
    await this.refresh();
    return result;
  }

  async subscribeCdp(events: string[]): Promise<PageCdpSubscription> {
    const subscriptionId = `desktop-page-${this.pageId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.manager.tabDebuggerSubscribeById({
      tabId: this.pageId,
      subscriptionId,
      events,
    });
    return {
      poll: request => this.manager.tabDebuggerPollById({
        subscriptionId,
        maxBatch: request?.maxBatch,
        maxWaitMs: request?.maxWaitMs,
      }),
      close: async () => {
        this.manager.tabDebuggerUnsubscribeById(subscriptionId);
      },
    };
  }

  async detachCdp(): Promise<void> {
    this.manager.tabDebuggerDetachById(this.pageId);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const tab = this.manager.getTabData(this.pageId);
    if (tab) {
      this.tab = tab;
    }
  }
}

export function sourceFromTab(tab: TabData): PageSource {
  const target = tab.target ?? '';
  if (tab.type === 'url') return { type: 'url', url: target };
  if (tab.type === 'file') {
    return {
      type: 'file',
      path: target,
      ...(tab.params ? { params: tab.params } : {}),
    };
  }
  return {
    type: 'view',
    name: target,
    ...(tab.params ? { params: tab.params } : {}),
  };
}
