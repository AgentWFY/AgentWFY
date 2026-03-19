import { ipcMain } from 'electron'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ProviderInfo } from '../agent/provider_types.js'
import { Channels } from './channels.js'

export function registerProviderHandlers(
  getRegistry: (e: Electron.IpcMainInvokeEvent) => ProviderRegistry,
): void {
  ipcMain.handle(Channels.providers.list, (event): ProviderInfo[] => {
    return getRegistry(event).list()
  })

  ipcMain.handle(Channels.providers.getStatusLine, (event, providerId: string): string => {
    const factory = getRegistry(event).get(providerId)
    if (!factory?.getStatusLine) return ''
    return factory.getStatusLine()
  })
}
