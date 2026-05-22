import { ipcMain, type WebContents } from 'electron'
import type { ProviderInfo } from '#shared/agent/provider_types.js'
import type { AgentBackend, ProviderState } from '#shared/backend/interface.js'
import { Channels } from './channels.cjs'

function pushProviderState(wc: WebContents, state: ProviderState): void {
  if (!wc.isDestroyed()) {
    wc.send(Channels.providers.stateChanged, state)
  }
}

export function registerProviderHandlers(
  getRendererWebContents: () => WebContents | undefined,
  getBackend: (e: Electron.IpcMainInvokeEvent) => AgentBackend,
): void {
  ipcMain.handle(Channels.providers.list, async (event): Promise<ProviderInfo[]> => {
    return getBackend(event).providers.list()
  })

  ipcMain.handle(Channels.providers.getStatusLine, async (event, providerId: string): Promise<string> => {
    return getBackend(event).providers.getStatusLine(providerId)
  })

  ipcMain.handle(Channels.providers.setDefault, async (event, providerId: string) => {
    const state = await getBackend(event).providers.setDefault(providerId)
    const wc = getRendererWebContents()
    if (wc) pushProviderState(wc, state)
  })
}
