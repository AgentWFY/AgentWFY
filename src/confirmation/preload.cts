import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL = {
  SHOW: 'app:confirmation:show',
  RESULT: 'app:confirmation:result',
  PICK_DIRECTORY: 'app:confirmation:pickDirectory',
} as const

contextBridge.exposeInMainWorld('confirmationBridge', {
  onShow(callback: (request: { screen: string; params: Record<string, unknown>; requestId: string }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, request: { screen: string; params: Record<string, unknown>; requestId: string }) => callback(request)
    ipcRenderer.on(CHANNEL.SHOW, handler)
    return () => ipcRenderer.removeListener(CHANNEL.SHOW, handler)
  },
  sendResult(requestId: string, confirmed: boolean, data?: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke(CHANNEL.RESULT, requestId, confirmed, data)
  },
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNEL.PICK_DIRECTORY)
  },
})
