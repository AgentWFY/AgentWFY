import { ipcMain } from 'electron';
import { TabViewManager, toNonEmptyString, type TabViewDestroyPayload } from './manager';
import { Channels } from '../ipc/channels';

export function registerTabViewHandlers(tabViewManager: TabViewManager): void {
  ipcMain.handle(Channels.tabs.mountView, async (_event, payload: unknown) => {
    await tabViewManager.mountTabView(payload);
  });

  ipcMain.handle(Channels.tabs.updateViewBounds, async (_event, payload: unknown) => {
    tabViewManager.setTabViewBounds(payload);
  });

  ipcMain.handle(Channels.tabs.destroyView, async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewDestroyPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    tabViewManager.destroyTabView(tabId);
  });

  ipcMain.handle(Channels.tabs.showContextMenu, async (event, payload: unknown) => {
    return tabViewManager.showNativeTabContextMenu(event, payload);
  });
}
