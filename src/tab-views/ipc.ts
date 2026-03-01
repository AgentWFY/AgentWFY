import { ipcMain } from 'electron';
import { TabViewManager, toNonEmptyString, type TabViewDestroyPayload } from './manager';

const TAB_VIEW_CHANNEL = {
  MOUNT: 'tabView:mount',
  SET_BOUNDS: 'tabView:setBounds',
  DESTROY: 'tabView:destroy',
} as const;

const TAB_CONTEXT_MENU_CHANNEL = 'app:tabs:context-menu';

export function registerTabViewHandlers(tabViewManager: TabViewManager): void {
  ipcMain.handle(TAB_VIEW_CHANNEL.MOUNT, async (_event, payload: unknown) => {
    await tabViewManager.mountTabView(payload);
  });

  ipcMain.handle(TAB_VIEW_CHANNEL.SET_BOUNDS, async (_event, payload: unknown) => {
    tabViewManager.setTabViewBounds(payload);
  });

  ipcMain.handle(TAB_VIEW_CHANNEL.DESTROY, async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Partial<TabViewDestroyPayload> : {};
    const tabId = toNonEmptyString(input.tabId);
    tabViewManager.destroyTabView(tabId);
  });

  ipcMain.handle(TAB_CONTEXT_MENU_CHANNEL, async (event, payload: unknown) => {
    return tabViewManager.showNativeTabContextMenu(event, payload);
  });
}
