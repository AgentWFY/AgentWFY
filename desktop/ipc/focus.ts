import { ipcMain } from 'electron';
import { Channels } from './channels.cjs';

interface FocusHandlerDeps {
  focusPage: () => void;
  focusApp: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export function registerFocusHandlers(deps: FocusHandlerDeps): void {
  ipcMain.handle(Channels.focus.page, () => {
    deps.focusPage();
  });

  ipcMain.handle(Channels.focus.app, () => {
    deps.focusApp();
  });

  ipcMain.handle(Channels.focus.setSidebarOpen, (_event, open: boolean) => {
    deps.setSidebarOpen(!!open);
  });
}
