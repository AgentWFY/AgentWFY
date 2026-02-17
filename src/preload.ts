// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronDialog', {
  open(options: any): Promise<string[]> {
    return ipcRenderer.invoke('dialog:open', options);
  },
});

contextBridge.exposeInMainWorld('electronStore', {
  getItem(key: string): Promise<any> {
    return ipcRenderer.invoke('electron-store:get', key);
  },
  setItem(key: string, value: any): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke('electron-store:set', key, value);
    }, 0);
    return Promise.resolve();
  },
  removeItem(key: string): Promise<void> {
    setTimeout(() => {
      ipcRenderer.invoke('electron-store:remove', key);
    }, 0);
    return Promise.resolve();
  },
});

contextBridge.exposeInMainWorld('electronAgentTools', {
  read(path: string, offset?: number, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:read', path, offset, limit);
  },
  write(path: string, content: string): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:write', path, content);
  },
  edit(path: string, oldText: string, newText: string): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:edit', path, oldText, newText);
  },
  ls(path?: string, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:ls', path, limit);
  },
  mkdir(path: string, recursive?: boolean): Promise<void> {
    return ipcRenderer.invoke('electronAgentTools:mkdir', path, recursive);
  },
  remove(path: string, recursive?: boolean): Promise<void> {
    return ipcRenderer.invoke('electronAgentTools:remove', path, recursive);
  },
  find(pattern: string, path?: string, limit?: number): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:find', pattern, path, limit);
  },
  grep(pattern: string, path?: string, options?: { ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string> {
    return ipcRenderer.invoke('electronAgentTools:grep', pattern, path, options);
  },
  captureWindowPng(): Promise<{ path: string; base64: string }> {
    return ipcRenderer.invoke('electronAgentTools:captureWindowPng');
  },
  getConsoleLogs(since?: number): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    return ipcRenderer.invoke('electronAgentTools:getConsoleLogs', since);
  },
});
