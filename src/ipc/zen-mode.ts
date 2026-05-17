import { ipcMain } from 'electron';
import { Channels } from './channels.cjs';

interface ZenModeHandlerDeps {
  toggleZenMode: () => void;
  setZenMode: (value: boolean) => void;
}

export function registerZenModeHandlers(deps: ZenModeHandlerDeps): void {
  ipcMain.handle(Channels.zenMode.toggle, () => {
    deps.toggleZenMode();
  });

  ipcMain.handle(Channels.zenMode.set, (_event, value: boolean) => {
    deps.setZenMode(!!value);
  });
}
