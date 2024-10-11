import { BrowserWindow } from 'electron';
import path from 'path';

declare const MAIN_WINDOW_VITE_NAME: string;
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;

export default function(parentWindow: BrowserWindow): BrowserWindow {
  const window = new BrowserWindow({
    parent: parentWindow,
    modal: true,
    height: 150,
    width: 200,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  window.show();

  return window
}
