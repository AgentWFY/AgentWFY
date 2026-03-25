import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('welcomeBridge', {
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('app:welcome:pickDirectory')
  },
  quit(): void {
    ipcRenderer.send('app:welcome:quit')
  },
})
