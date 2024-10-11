import { ipcRenderer, BrowserWindow, dialog, ipcMain, OpenDialogOptions } from 'electron';

export const ElectronDialog = {
  open(options: OpenDialogOptions): Promise<string[]> {
    return ipcRenderer.invoke('dialog:open', options);
  },
}

export const registerDialogSubscribers = (mainWindow: BrowserWindow) => {
  ipcMain.handle('dialog:open', async (_event, options: OpenDialogOptions) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, options);

    if (!canceled) {
      return filePaths;
    }

    return [];
  });
};
