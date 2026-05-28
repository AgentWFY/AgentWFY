import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { Channels } from './channels.cjs';
import { getViewByName } from '#shared/db/views.js';
import type { TabApi, TabOpenRequest } from '#shared/runtime/hosts.js';

function parseTabId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error('tabId must be a non-empty string');
}

export function registerTabsHandlers(
  getTabTools: (e: IpcMainInvokeEvent) => TabApi,
  getCacheRoot: (e: IpcMainInvokeEvent) => string,
) {
  // openTab({ viewName?, filePath?, url?, title? }) — exactly one of viewName, filePath, url required
  ipcMain.handle(Channels.tabs.openTab, async (event, payload: unknown) => {
    const input = payload as TabOpenRequest | undefined;
    if (!input) {
      throw new Error('openTab requires a request object');
    }

    const viewNameInput = typeof input.viewName === 'string' && input.viewName.length > 0
      ? input.viewName
      : (typeof input.view === 'string' && input.view.length > 0 ? input.view : undefined);

    // Validate viewName exists and resolve title
    const hasViewName = typeof viewNameInput === 'string' && viewNameInput.length > 0;
    let resolvedViewName = viewNameInput;
    let resolvedTitle = input.title;
    if (hasViewName) {
      const view = await getViewByName(getCacheRoot(event), viewNameInput!);
      if (!view) {
        throw new Error(`View not found: ${viewNameInput}`);
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
      headless: typeof input.headless === 'boolean' ? input.headless : false,
      viewport: input.viewport,
      params: params && Object.keys(params).length > 0 ? params : undefined,
    });
  });

  // closeTab({ tabId })
  ipcMain.handle(Channels.tabs.closeTab, async (event, payload: unknown) => {
    const input = payload as { tabId?: string } | undefined;
    const tabId = parseTabId(input?.tabId);
    return getTabTools(event).closeTab({ tabId });
  });

  // selectTab({ tabId })
  ipcMain.handle(Channels.tabs.selectTab, async (event, payload: unknown) => {
    const input = payload as { tabId?: string } | undefined;
    const tabId = parseTabId(input?.tabId);
    return getTabTools(event).selectTab({ tabId });
  });

}
