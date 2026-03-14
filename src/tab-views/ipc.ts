import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { TabViewManager, toNonEmptyString, type TabViewDestroyPayload } from './manager.js';
import { Channels } from '../ipc/channels.js';

export function registerTabViewHandlers(getTabViewManager: (e: IpcMainInvokeEvent) => TabViewManager): void {
  ipcMain.handle(Channels.tabs.mountView, async (event, payload: unknown) => {
    await getTabViewManager(event).mountTabView(payload);
  });

  ipcMain.handle(Channels.tabs.updateViewBounds, async (event, payload: unknown) => {
    getTabViewManager(event).setTabViewBounds(payload);
  });

  ipcMain.handle(Channels.tabs.destroyView, async (event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewDestroyPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    getTabViewManager(event).destroyTabView(tabId);
  });

  ipcMain.handle(Channels.tabs.showContextMenu, async (event, payload: unknown) => {
    return getTabViewManager(event).showNativeTabContextMenu(event, payload);
  });
}
