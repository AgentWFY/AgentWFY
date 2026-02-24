import { app, BrowserWindow, Menu, protocol, net } from 'electron';
import createVaultWindow from './vault_window';
import ElectronStore from 'electron-store';
import { registerElectronStoreSubscribers } from './ipc/store';
import { registerDialogSubscribers } from './ipc/dialog';
import { registerAgentToolsHandlers } from './ipc/agent-tools';
import { registerViewFileWatcher } from './ipc/view-watcher';
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

// Helper to get mime type
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

// Converts Node stream to Web Stream
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

/**
 * Unified file server that handles both full loads and range requests (seeking)
 * without using net.fetch
 */
const serveFile = async (request: Request, absolutePath: string) => {
  try {
    const fileStat = await stat(absolutePath);
    const rangeHeader = request.headers.get('Range');

    // Default headers required for video playback
    const headers = new Headers([
      ['Content-Type', getMimeType(absolutePath)],
      ['Accept-Ranges', 'bytes'], // Tells the browser "We support Seeking"
      ['X-Content-Type-Options', 'nosniff'],
    ]);

    // 1. Handle Range Request (Seeking / Partial Content)
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const matches = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      
      if (matches) {
        const startByte = matches[1] ? parseInt(matches[1], 10) : 0;
        const endByte = matches[2] ? parseInt(matches[2], 10) : fileStat.size - 1;

        // Validation
        if (startByte >= fileStat.size || endByte >= fileStat.size) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileStat.size}` }
          });
        }

        const chunksize = (endByte - startByte) + 1;
        const stream = createReadStream(absolutePath, { start: startByte, end: endByte });

        headers.set('Content-Range', `bytes ${startByte}-${endByte}/${fileStat.size}`);
        headers.set('Content-Length', chunksize.toString());

        return new Response(nodeStreamToWeb(stream), {
          status: 206, // Partial Content
          headers: headers,
        });
      }
    }

    // 2. Handle Full File Request (Initial Load)
    headers.set('Content-Length', fileStat.size.toString());
    
    const stream = createReadStream(absolutePath);
    return new Response(nodeStreamToWeb(stream), {
      status: 200, // OK
      headers: headers,
    });

  } catch (error) {
    console.error('File serving error:', error);
    return new Response('Not Found', { status: 404 });
  }
};

let vaultWindow: BrowserWindow | null;
let mainWindow: BrowserWindow | null;
let viewWatcher: { dispose: () => void } | null = null;

let clientPath = path.join(__dirname, 'client', 'index.html');

const DEFAULT_DATA_DIR = app.getPath('userData')

const store = new ElectronStore();
registerElectronStoreSubscribers(store);
registerDialogSubscribers();

function getAgentToolsRoot(): string {
  const dataDir = store.get('dataDir');
  const base = typeof dataDir === 'string' ? dataDir : app.getPath('userData');
  return path.join(base, 'agent');
}

registerAgentToolsHandlers(getAgentToolsRoot, () => mainWindow);

store.onDidChange('dataDir', async (newValue, oldValue) => {
  if (oldValue !== newValue) {
    await stopServer();
    viewWatcher?.dispose();
    viewWatcher = null;
  }
  if (newValue && typeof newValue === 'string') {
    await startServer(newValue);
    mainWindow.reload();
    viewWatcher = registerViewFileWatcher(getAgentToolsRoot, () => mainWindow);
  }
});

async function createAppWindow(dataDir: string) {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    show: false,
    title: dataDir,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      webviewTag: true,
    },
  });

  mainWindow.on('page-title-updated', (evt) => {
    evt.preventDefault();
  });

  mainWindow.maximize();

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  console.log('VITE_DEV_SERVER_URL:', devServerUrl);
  if (devServerUrl) {
    console.log('Loading from dev server:', devServerUrl);
    mainWindow.loadURL(devServerUrl);
  } else {
    console.log('Loading from app:// protocol');
    mainWindow.loadURL('app://index.html');
  }

  mainWindow.show();

  viewWatcher = registerViewFileWatcher(getAgentToolsRoot, () => mainWindow);

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

app.on('ready', () => {
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault',
          click: () => {
            if (vaultWindow && !vaultWindow.isDestroyed()) {
              vaultWindow.show();
            } else {
              vaultWindow = createVaultWindow(mainWindow);
            }
          },
        },
        {
          label: 'Devtools',
          click: () => {
            mainWindow?.webContents.openDevTools();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ]
          : [
              { role: 'close' }
            ])
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // --- MODIFIED MEDIA PROTOCOL HANDLER ---
  protocol.handle('media', async (request) => {
    const dataDir = store.get('dataDir') as string || DEFAULT_DATA_DIR;
    const url = new URL(request.url);
    const relativePath = path.join(url.hostname, decodeURIComponent(url.pathname));
    const absolutePath = path.join(dataDir, relativePath);

    // Use the unified fs server instead of net.fetch
    return serveFile(request, absolutePath);
  });

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);

    if (p.startsWith('/agent/')) {
      const dataDir = store.get('dataDir') as string || DEFAULT_DATA_DIR;
      const absolutePath = path.join(dataDir, 'agent', p.replace(/^\/agent\//, ''));
      return net.fetch(pathToFileURL(absolutePath).toString());
    }

    const clientDir = path.dirname(clientPath);
    const absolutePath = path.join(clientDir, p === '/' ? 'index.html' : p);
    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  createWindow()
});

app.on('window-all-closed', () => {
  viewWatcher?.dispose();
  viewWatcher = null;
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
