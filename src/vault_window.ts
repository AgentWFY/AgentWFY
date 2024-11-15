import { BrowserWindow } from 'electron';
import path from 'path';

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

  window.loadFile(path.join(__dirname, `vault_window.html`));

  window.show();

  return window
}
