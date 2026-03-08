import { ipcMain } from 'electron';
import { Channels } from './channels.js';

interface CaptureTabRequest {
  tabId: string
}

interface GetTabConsoleLogsRequest {
  tabId: string
  since?: number
  limit?: number
}

interface ExecTabJsRequest {
  tabId: string
  code: string
  timeoutMs?: number
}

interface GetTabsResult {
  tabs: Array<Record<string, unknown>>
}

interface OpenTabRequest {
  viewId?: string | number
  filePath?: string
  url?: string
  title?: string
}

interface CloseTabRequest {
  tabId: string
}

interface SelectTabRequest {
  tabId: string
}

interface ReloadTabRequest {
  tabId: string
}

export interface AgentTabTools {
  getTabs: () => Promise<GetTabsResult>
  openTab: (request: OpenTabRequest) => Promise<void>
  closeTab: (request: CloseTabRequest) => Promise<void>
  selectTab: (request: SelectTabRequest) => Promise<void>
  reloadTab: (request: ReloadTabRequest) => Promise<void>
  captureTab: (request: CaptureTabRequest) => Promise<{ base64: string; mimeType: 'image/png' }>
  getTabConsoleLogs: (request: GetTabConsoleLogsRequest) => Promise<Array<{ level: string; message: string; timestamp: number }>>
  execTabJs: (request: ExecTabJsRequest) => Promise<unknown>
}

function parseTabId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error('tabId must be a non-empty string');
}

function parseOptionalNumber(value: unknown, label: string): number | undefined {
  if (typeof value === 'undefined' || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number when provided`);
  }

  return value;
}

export function registerTabsHandlers(tabTools: AgentTabTools) {
  // getTabs() → { tabs: [...] }
  ipcMain.handle(Channels.tabs.getTabs, async () => {
    return tabTools.getTabs();
  });

  // openTab({ viewId?, filePath?, url?, title? }) — exactly one of viewId, filePath, url required
  ipcMain.handle(Channels.tabs.openTab, async (_event, payload: unknown) => {
    const input = payload as OpenTabRequest | undefined;
    if (!input) {
      throw new Error('openTab requires a request object');
    }

    const hasViewId = typeof input.viewId === 'string' || typeof input.viewId === 'number';
    const hasFilePath = typeof input.filePath === 'string' && input.filePath.length > 0;
    const hasUrl = typeof input.url === 'string' && input.url.length > 0;
    const sourceCount = (hasViewId ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0);

    if (sourceCount !== 1) {
      throw new Error('openTab requires exactly one of viewId, filePath, or url');
    }

    return tabTools.openTab({
      viewId: hasViewId ? input.viewId : undefined,
      filePath: hasFilePath ? input.filePath : undefined,
      url: hasUrl ? input.url : undefined,
      title: typeof input.title === 'string' ? input.title : undefined,
    });
  });

  // closeTab({ tabId })
  ipcMain.handle(Channels.tabs.closeTab, async (_event, payload: unknown) => {
    const input = payload as CloseTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return tabTools.closeTab({ tabId });
  });

  // selectTab({ tabId })
  ipcMain.handle(Channels.tabs.selectTab, async (_event, payload: unknown) => {
    const input = payload as SelectTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return tabTools.selectTab({ tabId });
  });

  // reloadTab({ tabId })
  ipcMain.handle(Channels.tabs.reloadTab, async (_event, payload: unknown) => {
    const input = payload as ReloadTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return tabTools.reloadTab({ tabId });
  });

  // captureTab({ tabId }) → { base64, mimeType }
  ipcMain.handle(Channels.tabs.captureTab, async (_event, payload: unknown) => {
    const input = payload as CaptureTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return tabTools.captureTab({ tabId });
  });

  // getConsoleLogs({ tabId, since?, limit? }) → logs[]
  ipcMain.handle(Channels.tabs.getConsoleLogs, async (_event, payload: unknown) => {
    const input = payload as GetTabConsoleLogsRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    const since = parseOptionalNumber(input?.since, 'since');
    const limit = parseOptionalNumber(input?.limit, 'limit');
    if (typeof limit === 'number' && limit < 1) {
      throw new Error('limit must be >= 1 when provided');
    }

    return tabTools.getTabConsoleLogs({
      tabId,
      since,
      limit,
    });
  });

  // execJs({ tabId, code, timeoutMs? }) → execution result
  ipcMain.handle(Channels.tabs.execJs, async (_event, payload: unknown) => {
    const input = payload as ExecTabJsRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    if (!input || typeof input.code !== 'string') {
      throw new Error('execTabJs requires code as a string');
    }

    const timeoutMs = parseOptionalNumber(input.timeoutMs, 'timeoutMs');
    if (typeof timeoutMs === 'number' && timeoutMs < 1) {
      throw new Error('timeoutMs must be >= 1 when provided');
    }

    return tabTools.execTabJs({
      tabId,
      code: input.code,
      timeoutMs,
    });
  });
}
