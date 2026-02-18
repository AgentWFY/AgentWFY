import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';

const IPC_CHANNEL = 'viewFileChanged';
const DEBOUNCE_MS = 300;
const RETRY_INTERVAL_MS = 5000;

export function registerViewFileWatcher(
  getRoot: () => string,
  getMainWindow: () => BrowserWindow | null
): { dispose: () => void } {
  const watchers: fs.FSWatcher[] = [];
  const retryTimers: ReturnType<typeof setInterval>[] = [];
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function notify(relativePath: string, event: 'change' | 'rename') {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNEL, { path: relativePath, event });
    }
  }

  function debounceNotify(relativePath: string, event: 'change' | 'rename') {
    const existing = debounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(relativePath, setTimeout(() => {
      debounceTimers.delete(relativePath);
      notify(relativePath, event);
    }, DEBOUNCE_MS));
  }

  function watchDir(absoluteDir: string, relativePrefix: string) {
    try {
      const watcher = fs.watch(absoluteDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.js')) return;
        const relativePath = relativePrefix + '/' + filename;
        debounceNotify(relativePath, eventType as 'change' | 'rename');
      });
      watchers.push(watcher);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('[view-watcher] Failed to watch', absoluteDir, err);
      }
    }
  }

  function tryWatchWithRetry(absoluteDir: string, relativePrefix: string) {
    try {
      fs.accessSync(absoluteDir);
      watchDir(absoluteDir, relativePrefix);
    } catch {
      const timer = setInterval(() => {
        try {
          fs.accessSync(absoluteDir);
          const idx = retryTimers.indexOf(timer);
          if (idx !== -1) retryTimers.splice(idx, 1);
          clearInterval(timer);
          watchDir(absoluteDir, relativePrefix);
        } catch {
          // Directory still doesn't exist, keep retrying
        }
      }, RETRY_INTERVAL_MS);
      retryTimers.push(timer);
    }
  }

  const root = getRoot();
  tryWatchWithRetry(path.join(root, 'views'), 'views');
  tryWatchWithRetry(path.join(root, 'tmp', 'views'), 'tmp/views');

  return {
    dispose() {
      for (const timer of retryTimers) clearInterval(timer);
      retryTimers.length = 0;
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      watchers.length = 0;
    }
  };
}
