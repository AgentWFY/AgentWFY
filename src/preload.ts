// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge } from 'electron';

import { ElectronDialog } from './ipc/dialog';
import { Store } from './ipc/store';

contextBridge.exposeInMainWorld('electronDialog', ElectronDialog);
contextBridge.exposeInMainWorld('electronStore', Store);
