import { ipcRenderer, BrowserWindow, dialog, ipcMain, OpenDialogOptions } from 'electron';

export const ElectronDialog = {
  open(options: OpenDialogOptions): Promise<string[]> {
    return ipcRenderer.invoke('dialog:open', options);
  },
}

export const registerDialogSubscribers = () => {
  ipcMain.handle('dialog:open', async (event, options: OpenDialogOptions) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(window, options);

    if (!canceled) {
      return filePaths;
    }

    return [];
  });
};
