import { ipcRenderer, BrowserWindow, dialog, ipcMain, OpenDialogOptions, shell } from 'electron';

const OPEN_DIALOG_CHANNEL = 'dialog:open';
const OPEN_URL_IN_DEFAULT_BROWSER_CHANNEL = 'shell:openUrlInDefaultBrowser';

export const ElectronDialog = {
  open(options: OpenDialogOptions): Promise<string[]> {
    return ipcRenderer.invoke(OPEN_DIALOG_CHANNEL, options);
  },
  openUrlInDefaultBrowser(url: string): Promise<void> {
    return ipcRenderer.invoke(OPEN_URL_IN_DEFAULT_BROWSER_CHANNEL, url);
  },
}

export const registerDialogSubscribers = () => {
  ipcMain.handle(OPEN_DIALOG_CHANNEL, async (event, options: OpenDialogOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(window, options);

    if (!canceled) {
      return filePaths;
    }

    return [];
  });

  ipcMain.handle(OPEN_URL_IN_DEFAULT_BROWSER_CHANNEL, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      throw new Error('openUrlInDefaultBrowser requires a non-empty URL string');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid URL passed to openUrlInDefaultBrowser');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('openUrlInDefaultBrowser only supports http/https URLs');
    }

    await shell.openExternal(parsed.toString());
  });
};
