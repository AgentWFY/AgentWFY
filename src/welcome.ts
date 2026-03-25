import { BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Show a welcome window for first-time users.
 * Returns the chosen directory path, or null if the user quits.
 */
export function showWelcomeWindow(): Promise<string | null> {
  return new Promise((resolve) => {
    const iconPath = path.join(import.meta.dirname, '..', 'icons', 'icon.png');

    const win = new BrowserWindow({
      width: 420,
      height: 320,
      icon: nativeImage.createFromPath(iconPath),
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      titleBarStyle: 'hidden',
      roundedCorners: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f0f0f0',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'welcome-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let resolved = false;
    function done(result: string | null) {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!win.isDestroyed()) win.close();
      resolve(result);
    }

    const handlePickDirectory = async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose a Directory for Your Agent',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      done(result.filePaths[0]);
      return result.filePaths[0];
    };

    const handleQuit = () => {
      done(null);
    };

    function cleanup() {
      ipcMain.removeHandler('app:welcome:pickDirectory');
      ipcMain.removeAllListeners('app:welcome:quit');
    }

    ipcMain.handle('app:welcome:pickDirectory', handlePickDirectory);
    ipcMain.on('app:welcome:quit', handleQuit);

    win.on('closed', () => {
      done(null);
    });

    win.once('ready-to-show', () => {
      win.center();
      win.show();
    });

    void win.loadURL(pathToFileURL(path.join(import.meta.dirname, 'welcome.html')).toString());
  });
}
