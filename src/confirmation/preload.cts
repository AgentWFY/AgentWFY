import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL = {
  SHOW: 'app:confirmation:show',
  RESULT: 'app:confirmation:result',
} as const

contextBridge.exposeInMainWorld('confirmationBridge', {
  onShow(callback: (request: { screen: string; params: Record<string, unknown>; requestId: string }) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, request: { screen: string; params: Record<string, unknown>; requestId: string }) => callback(request)
    ipcRenderer.on(CHANNEL.SHOW, handler)
    return () => ipcRenderer.removeListener(CHANNEL.SHOW, handler)
  },
  sendResult(requestId: string, confirmed: boolean): Promise<void> {
    return ipcRenderer.invoke(CHANNEL.RESULT, requestId, confirmed)
  },
})
