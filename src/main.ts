import { app, BrowserWindow, Menu, protocol, net } from 'electron';
import createVaultWindow from './vault_window';
import ElectronStore from 'electron-store';
import { registerElectronStoreSubscribers } from './ipc/store';
import { registerDialogSubscribers } from './ipc/dialog';
import { startServer, stopServer } from './server';
import path from 'path';
import { pathToFileURL } from 'url';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: true
    }
  },
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);

// Helper to get mime type without external dependency
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// Converts Node stream to Web Stream to avoid double-close issues in Electron/Node
const nodeStreamToWeb = (nodeStream: any) => {
  nodeStream.pause();
  let closed = false;

  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: any) => {
        if (closed) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on('error', (err: any) => controller.error(err));
      nodeStream.on('end', () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
    },
    pull() {
      if (!closed) nodeStream.resume();
    },
    cancel() {
      if (!closed) {
        closed = true;
        nodeStream.destroy();
      }
    }
  });
};

const handleRangeRequest = async (request: Request, targetPath: string) => {
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return new Response('Unsupported range', { status: 416 });
  }

  const fileStat = await stat(targetPath);
  const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!matches) return new Response('Invalid range', { status: 416 });

  const startByte = matches[1] ? parseInt(matches[1], 10) : 0;
  const endByte = matches[2] ? parseInt(matches[2], 10) : fileStat.size - 1;

  if (startByte >= fileStat.size || endByte >= fileStat.size) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileStat.size}` }
    });
  }

  const chunksize = (endByte - startByte) + 1;
  const stream = createReadStream(targetPath, { start: startByte, end: endByte });

  const headers = new Headers([
    ['Accept-Ranges', 'bytes'],
    ['Content-Type', getMimeType(targetPath)],
    ['Content-Length', chunksize.toString()],
    ['Content-Range', `bytes ${startByte}-${endByte}/${fileStat.size}`],
    ['X-Content-Type-Options', 'nosniff'],
  ]);

  return new Response(nodeStreamToWeb(stream), {
    status: 206,
    headers: headers,
  });
};

let vaultWindow: BrowserWindow | null;
let mainWindow: BrowserWindow | null;

let clientPath = path.join(__dirname, 'client', 'index.html');

const store = new ElectronStore();
registerElectronStoreSubscribers(store);

store.onDidChange('dataDir', async (newValue, oldValue) => {
  if (oldValue !== newValue) {
    await stopServer();
  }
  if (newValue && typeof newValue === 'string') {
    await startServer(newValue);
    mainWindow.reload();
  }
});

const DEFAULT_DATA_DIR = app.getPath('userData')

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
  mainWindow.loadURL('app://index.html');
  mainWindow.show();

  await startServer(dataDir);

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'r' && input.control) {
      mainWindow?.reload();
    }
  });
}

const createWindow = () => {
  const dataDir = store.get('dataDir');
  if (typeof dataDir === 'string') return createAppWindow(dataDir)
  createAppWindow(DEFAULT_DATA_DIR)
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

  protocol.handle('media', async (request) => {
    const dataDir = store.get('dataDir') as string || DEFAULT_DATA_DIR;
    const url = new URL(request.url);
    const relativePath = path.join(url.hostname, decodeURIComponent(url.pathname));
    const absolutePath = path.join(dataDir, relativePath);

    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      return handleRangeRequest(request, absolutePath);
    }

    const response = await net.fetch(pathToFileURL(absolutePath).toString());
    // Ensure accurate content type for files loaded normally
    const headers = new Headers(response.headers);
    headers.set('Content-Type', getMimeType(absolutePath));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  });

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const clientDir = path.dirname(clientPath);
    const p = decodeURIComponent(url.pathname);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

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
