import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Channels } from './channels.js';

const storePath = path.join(app.getPath('userData'), 'config.json');

function readStoreFromDisk(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStoreToDisk(data: Record<string, unknown>): void {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

let cache: Record<string, unknown> = readStoreFromDisk();

export function storeGet(key: string): unknown {
  return cache[key];
}

export function storeSet(key: string, value: unknown): void {
  cache[key] = value;
  writeStoreToDisk(cache);
}

export function storeRemove(key: string): void {
  delete cache[key];
  writeStoreToDisk(cache);
}

export function getStorePath(): string {
  return storePath;
}

type ChangeListener = (newValue: unknown, oldValue: unknown) => void;
const changeListeners: Map<string, ChangeListener[]> = new Map();

export function onDidChange(key: string, listener: ChangeListener): void {
  const listeners = changeListeners.get(key) ?? [];
  listeners.push(listener);
  changeListeners.set(key, listeners);
}

type AnyChangeListener = (key: string, newValue: unknown) => void;
const anyChangeListeners: AnyChangeListener[] = [];

export function onAnyChange(listener: AnyChangeListener): void {
  anyChangeListeners.push(listener);
}

function fireChangeListeners(key: string, newValue: unknown, oldValue: unknown): void {
  for (const listener of changeListeners.get(key) ?? []) {
    listener(newValue, oldValue);
  }
  for (const listener of anyChangeListeners) {
    listener(key, newValue);
  }
}

// --- File watcher ---

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function handleExternalChange(): void {
  const diskData = readStoreFromDisk();
  const allKeys = new Set([...Object.keys(cache), ...Object.keys(diskData)]);
  const oldCache = cache;
  cache = diskData;

  for (const key of allKeys) {
    const oldVal = JSON.stringify(oldCache[key]);
    const newVal = JSON.stringify(diskData[key]);
    if (oldVal !== newVal) {
      fireChangeListeners(key, diskData[key], oldCache[key]);
    }
  }
}

export function startFileWatcher(): void {
  if (watcher) return;

  try {
    writeStoreToDisk(cache);
    watcher = fs.watch(storePath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(handleExternalChange, 100);
    });
  } catch (err) {
    console.warn('[store] failed to start file watcher:', err);
  }
}

export function stopFileWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

// --- IPC handlers ---

export const registerStoreHandlers = () => {
  ipcMain.handle(Channels.store.get, async (_event, key) => storeGet(key));

  ipcMain.handle(Channels.store.set, async (_event, key, value) => {
    const oldValue = storeGet(key);
    storeSet(key, value);
    fireChangeListeners(key, value, oldValue);
  });

  ipcMain.handle(Channels.store.remove, async (_event, key) => {
    const oldValue = storeGet(key);
    storeRemove(key);
    fireChangeListeners(key, undefined, oldValue);
  });
};
