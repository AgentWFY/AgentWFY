import { ipcRenderer, ipcMain } from 'electron';
import ElectronStore from 'electron-store';

export enum ElectronStoreChannel {
  GET = 'electron-store:get',
  SET = 'electron-store:set',
  REMOVE = 'electron-store:remove',
}

export const Store = {
  getItem<T = any>(key: string): Promise<T> {
    return ipcRenderer.invoke(ElectronStoreChannel.GET, key);
  },
  setItem<T = any>(key: string, value: T): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke(ElectronStoreChannel.SET, key, value);
    }, 0);

    return Promise.resolve();
  },
  removeItem(key: string): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke(ElectronStoreChannel.REMOVE, key);
    }, 0);

    return Promise.resolve();
  },
};

export const registerElectronStoreSubscribers = (store: ElectronStore) => {
  ipcMain.handle(ElectronStoreChannel.GET, async (_event, value) => store.get(value));

  ipcMain.handle(ElectronStoreChannel.SET, async (_event, key, value) => {
    store.set(key, value);
  });

  ipcMain.handle(ElectronStoreChannel.REMOVE, async (_event, key) => {
    store.reset(key);
  });
};
