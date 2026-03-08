import { BrowserWindow } from 'electron';
import path from 'path';

export default function(parentWindow: BrowserWindow): BrowserWindow {
  const window = new BrowserWindow({
    parent: parentWindow,
    modal: true,
    height: 150,
    width: 200,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: false,
    },
  });

  window.loadFile(path.join(import.meta.dirname, `vault_window.html`));

  window.show();

  return window
}
