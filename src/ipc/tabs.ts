import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { Channels } from './channels.js';
import { getViewByName } from '../db/views.js';

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
  viewName?: string
  filePath?: string
  url?: string
  title?: string
  hidden?: boolean
  params?: Record<string, string>
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
  openTab: (request: OpenTabRequest) => Promise<{ tabId: string }>
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

export function registerTabsHandlers(
  getTabTools: (e: IpcMainInvokeEvent) => AgentTabTools,
  getAgentRoot: (e: IpcMainInvokeEvent) => string,
) {
  // openTab({ viewName?, filePath?, url?, title? }) — exactly one of viewName, filePath, url required
  ipcMain.handle(Channels.tabs.openTab, async (event, payload: unknown) => {
    const input = payload as OpenTabRequest | undefined;
    if (!input) {
      throw new Error('openTab requires a request object');
    }

    // Validate viewName exists and resolve title
    const hasViewName = typeof input.viewName === 'string' && input.viewName.length > 0;
    let resolvedViewName = input.viewName;
    let resolvedTitle = input.title;
    if (hasViewName) {
      const view = await getViewByName(getAgentRoot(event), input.viewName!);
      if (!view) {
        throw new Error(`View not found: ${input.viewName}`);
      }
      resolvedViewName = view.name;
      if (typeof resolvedTitle !== 'string') {
        resolvedTitle = view.title || view.name;
      }
    }

    const hasResolvedViewName = typeof resolvedViewName === 'string' && resolvedViewName.length > 0;
    const hasFilePath = typeof input.filePath === 'string' && input.filePath.length > 0;
    const hasUrl = typeof input.url === 'string' && input.url.length > 0;
    const sourceCount = (hasResolvedViewName ? 1 : 0) + (hasFilePath ? 1 : 0) + (hasUrl ? 1 : 0);

    if (sourceCount !== 1) {
      throw new Error('openTab requires exactly one of viewName, filePath, or url');
    }

    const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
      ? Object.fromEntries(
          Object.entries(input.params).filter(([, v]) => typeof v === 'string')
        ) as Record<string, string>
      : undefined;

    return getTabTools(event).openTab({
      viewName: hasResolvedViewName ? resolvedViewName : undefined,
      filePath: hasFilePath ? input.filePath : undefined,
      url: hasUrl ? input.url : undefined,
      title: typeof resolvedTitle === 'string' ? resolvedTitle : undefined,
      hidden: typeof input.hidden === 'boolean' ? input.hidden : undefined,
      params: params && Object.keys(params).length > 0 ? params : undefined,
    });
  });

  // closeTab({ tabId })
  ipcMain.handle(Channels.tabs.closeTab, async (event, payload: unknown) => {
    const input = payload as CloseTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return getTabTools(event).closeTab({ tabId });
  });

  // selectTab({ tabId })
  ipcMain.handle(Channels.tabs.selectTab, async (event, payload: unknown) => {
    const input = payload as SelectTabRequest | undefined;
    const tabId = parseTabId(input?.tabId);
    return getTabTools(event).selectTab({ tabId });
  });

}
