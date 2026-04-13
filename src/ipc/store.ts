import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Channels } from './channels.cjs';

// Lazy-initialized: storePath depends on app.name which is set after ESM imports resolve.
let storePath = '';
let cache: Record<string, unknown> = {};
let storeReady = false;

function ensureInit(): void {
  if (storeReady) return;
  storeReady = true;
  storePath = path.join(app.getPath('userData'), 'config.json');
  cache = readStoreFromDisk();
}

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

export function storeGet(key: string): unknown {
  ensureInit();
  return cache[key];
}

export function storeSet(key: string, value: unknown): void {
  ensureInit();
  const oldValue = cache[key];
  cache[key] = value;
  writeStoreToDisk(cache);
  if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
    fireChangeListeners(key, value, oldValue);
  }
}

export function storeRemove(key: string): void {
  ensureInit();
  const oldValue = cache[key];
  delete cache[key];
  writeStoreToDisk(cache);
  if (oldValue !== undefined) {
    fireChangeListeners(key, undefined, oldValue);
  }
}

export function getStorePath(): string {
  ensureInit();
  return storePath;
}

type AnyChangeListener = (key: string, newValue: unknown) => void;
const anyChangeListeners: AnyChangeListener[] = [];

export function onAnyChange(listener: AnyChangeListener): void {
  anyChangeListeners.push(listener);
}

function fireChangeListeners(key: string, newValue: unknown, _oldValue: unknown): void {
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
  ensureInit();
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
    storeSet(key, value);
  });

  ipcMain.handle(Channels.store.remove, async (_event, key) => {
    storeRemove(key);
  });
};
