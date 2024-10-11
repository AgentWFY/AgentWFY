import { app, BrowserWindow, Menu } from 'electron';
import createVaultWindow from './vault_window';
import ElectronStore from 'electron-store';
import { registerElectronStoreSubscribers } from './ipc/store';
import { registerDialogSubscribers } from './ipc/dialog';
import { startServer, stopServer } from './server';
import electronIsDev from "electron-is-dev";
import path from 'path';
import started from "electron-squirrel-startup"

let vaultWindow: BrowserWindow | null;
let mainWindow: BrowserWindow | null;

let clientPath = ''
if (electronIsDev) {
  clientPath = path.join(__dirname, 'client', 'dist', 'index.html');
} else {
  clientPath = path.join(process.resourcesPath, 'app', '.webpack', 'main', 'client', 'dist', 'index.html');
}

const store = new ElectronStore();
registerElectronStoreSubscribers(store);

store.onDidChange('dataDir', async (newValue, oldValue) => {
  if (oldValue !== newValue) {
    mainWindow.loadFile(clientPath);
    await stopServer();
  }
  if (newValue && typeof newValue === 'string') {
    await startServer(newValue);
    mainWindow.loadURL("http://localhost:23578");
  }
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  stopServer();
  app.quit();
}
async function createAppWindow(dataDir: string) {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    show: false,
    title: dataDir,
  });

  mainWindow.on('page-title-updated', (evt) => {
    evt.preventDefault();
  });

  mainWindow.maximize();
  mainWindow.loadFile(clientPath);
  mainWindow.show();

  await startServer(dataDir);
  mainWindow.loadURL("http://localhost:23578");

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'r' && input.control) {
      mainWindow?.reload();
    }
  });
}

const createWindow = () => {
  const dataDir = store.get('dataDir');
  if (typeof dataDir === 'string') return createAppWindow(dataDir)
  createVaultWindow(mainWindow);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  const menu = Menu.buildFromTemplate([
    // Add a 'File' menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault',
          click: () => {
            if (vaultWindow && !vaultWindow.isDestroyed()) {
              vaultWindow.show();
            } else if (!vaultWindow) {
              vaultWindow = createVaultWindow(mainWindow);
              registerDialogSubscribers(vaultWindow);
            } else {
              vaultWindow = createVaultWindow(mainWindow);
            }
          },
        },
        {
          label: 'Devtools',
          click: () => {
            mainWindow.webContents.openDevTools();
          },
        },
      ],
    },
  ]);

  // Set the application menu to our custom menu
  Menu.setApplicationMenu(menu);

  createWindow()
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
