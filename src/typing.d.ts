import { ElectronDialog } from './ipc/dialog';
import { Store } from './ipc/store'

declare global {
  interface Window {
    electronDialog: typeof ElectronDialog;
    electronStore: typeof Store;
  }
}
