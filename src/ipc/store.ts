import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Channels } from './channels.js';

const storePath = path.join(app.getPath('userData'), 'config.json');

function readStore(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, unknown>): void {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

export function storeGet(key: string): unknown {
  return readStore()[key];
}

export function storeSet(key: string, value: unknown): void {
  const data = readStore();
  data[key] = value;
  writeStore(data);
}

export function storeRemove(key: string): void {
  const data = readStore();
  delete data[key];
  writeStore(data);
}

type ChangeListener = (newValue: unknown, oldValue: unknown) => void;
const changeListeners: Map<string, ChangeListener[]> = new Map();

export function onDidChange(key: string, listener: ChangeListener): void {
  const listeners = changeListeners.get(key) ?? [];
  listeners.push(listener);
  changeListeners.set(key, listeners);
}

export const registerStoreHandlers = () => {
  ipcMain.handle(Channels.store.get, async (_event, key) => storeGet(key));

  ipcMain.handle(Channels.store.set, async (_event, key, value) => {
    const oldValue = storeGet(key);
    storeSet(key, value);
    for (const listener of changeListeners.get(key) ?? []) {
      listener(value, oldValue);
    }
  });

  ipcMain.handle(Channels.store.remove, async (_event, key) => {
    const oldValue = storeGet(key);
    storeRemove(key);
    for (const listener of changeListeners.get(key) ?? []) {
      listener(undefined, oldValue);
    }
  });
};
