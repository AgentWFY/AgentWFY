import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export enum StoreChannel {
  GET = 'electron-store:get',
  SET = 'electron-store:set',
  REMOVE = 'electron-store:remove',
}

const storePath = path.join(app.getPath('userData'), 'config.json');

function readStore(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStore(data: Record<string, any>): void {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

export function storeGet(key: string): any {
  return readStore()[key];
}

export function storeSet(key: string, value: any): void {
  const data = readStore();
  data[key] = value;
  writeStore(data);
}

export function storeRemove(key: string): void {
  const data = readStore();
  delete data[key];
  writeStore(data);
}

type ChangeListener = (newValue: any, oldValue: any) => void;
const changeListeners: Map<string, ChangeListener[]> = new Map();

export function onDidChange(key: string, listener: ChangeListener): void {
  const listeners = changeListeners.get(key) ?? [];
  listeners.push(listener);
  changeListeners.set(key, listeners);
}

export const registerStoreHandlers = () => {
  ipcMain.handle(StoreChannel.GET, async (_event, key) => storeGet(key));

  ipcMain.handle(StoreChannel.SET, async (_event, key, value) => {
    const oldValue = storeGet(key);
    storeSet(key, value);
    for (const listener of changeListeners.get(key) ?? []) {
      listener(value, oldValue);
    }
  });

  ipcMain.handle(StoreChannel.REMOVE, async (_event, key) => {
    const oldValue = storeGet(key);
    storeRemove(key);
    for (const listener of changeListeners.get(key) ?? []) {
      listener(undefined, oldValue);
    }
  });
};
