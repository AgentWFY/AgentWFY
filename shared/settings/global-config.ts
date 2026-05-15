import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GLOBAL_CONFIG_PATH = process.env.AGENTWFY_CONFIG || path.join(os.homedir(), '.agentwfy.json');

let cache: Record<string, unknown> | null = null;
let selfWrite = false;

function readFromDisk(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function ensureCache(): Record<string, unknown> {
  if (cache === null) cache = readFromDisk();
  return cache;
}

function writeToDisk(data: Record<string, unknown>): void {
  selfWrite = true;
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(data, null, 2));
}

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_PATH;
}

export function globalConfigExists(): boolean {
  return fs.existsSync(GLOBAL_CONFIG_PATH);
}

export function ensureGlobalConfig(): void {
  if (!globalConfigExists()) {
    cache = {};
    writeToDisk(cache);
    startGlobalConfigWatcher();
  }
}

export function globalConfigGet(key: string): unknown {
  return ensureCache()[key];
}

export function globalConfigSet(key: string, value: unknown): void {
  const created = !globalConfigExists();
  ensureCache()[key] = value;
  writeToDisk(cache!);
  if (created) startGlobalConfigWatcher();
  fireChangeListeners(key, value);
}

export function globalConfigRemove(key: string): void {
  delete ensureCache()[key];
  writeToDisk(cache!);
  fireChangeListeners(key, undefined);
}

// --- Change listeners ---

type ChangeListener = (key: string, newValue: unknown) => void;
const changeListeners: ChangeListener[] = [];

export function onGlobalConfigChange(listener: ChangeListener): void {
  changeListeners.push(listener);
}

function fireChangeListeners(key: string, newValue: unknown): void {
  for (const listener of changeListeners) {
    listener(key, newValue);
  }
}

// --- File watcher ---

let watcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function handleExternalChange(): void {
  if (selfWrite) { selfWrite = false; return; }

  const diskData = readFromDisk();
  const oldCache = cache ?? {};
  cache = diskData;

  const allKeys = new Set([...Object.keys(oldCache), ...Object.keys(diskData)]);
  for (const key of allKeys) {
    const oldVal = JSON.stringify(oldCache[key]);
    const newVal = JSON.stringify(diskData[key]);
    if (oldVal !== newVal) {
      fireChangeListeners(key, diskData[key]);
    }
  }
}

export function startGlobalConfigWatcher(): void {
  if (watcher) return;
  if (!globalConfigExists()) return;

  try {
    watcher = fs.watch(GLOBAL_CONFIG_PATH, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(handleExternalChange, 100);
    });
  } catch (err) {
    console.warn('[global-config] failed to start file watcher:', err);
  }
}

export function stopGlobalConfigWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
