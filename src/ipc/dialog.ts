import { BaseWindow, BrowserWindow, dialog, ipcMain, OpenDialogOptions, shell } from 'electron';
import { Channels } from './channels.cjs';

export const registerDialogSubscribers = () => {
  ipcMain.handle(Channels.dialog.open, async (event, options: OpenDialogOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? BaseWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(window!, options);

    if (!canceled) {
      return filePaths;
    }

    return [];
  });

  ipcMain.handle(Channels.dialog.openExternal, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      throw new Error('openExternal requires a non-empty URL string');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL passed to openExternal');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('openExternal only supports http/https URLs');
    }

    await shell.openExternal(parsed.toString());
  });
};
