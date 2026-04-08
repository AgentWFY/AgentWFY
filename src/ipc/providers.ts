import { ipcMain, type WebContents } from 'electron'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ProviderInfo } from '../agent/provider_types.js'
import { Channels } from './channels.js'
import { getConfigValue, setAgentConfig } from '../settings/config.js'

export interface ProviderState {
  providerList: ProviderInfo[]
  defaultProviderId: string
  providerStatusLines: Array<[string, string]>
}

export function buildProviderState(agentRoot: string, registry: ProviderRegistry): ProviderState {
  const defaultId = (getConfigValue(agentRoot, 'system.provider', 'openai-compatible') as string) || 'openai-compatible'
  const providerList = registry.list()
  const statusLines: Array<[string, string]> = providerList.map(p => {
    const factory = registry.get(p.id)
    return [p.id, factory?.getStatusLine?.() ?? '']
  })
  return { providerList, defaultProviderId: defaultId, providerStatusLines: statusLines }
}

export function pushProviderState(wc: WebContents, state: ProviderState): void {
  if (!wc.isDestroyed()) {
    wc.send(Channels.providers.stateChanged, state)
  }
}

export function registerProviderHandlers(
  getRegistry: (e: Electron.IpcMainInvokeEvent) => ProviderRegistry,
  getAgentRoot: (e: Electron.IpcMainInvokeEvent) => string,
  getRendererWebContents: () => WebContents | undefined,
  onReconnect: (e: Electron.IpcMainInvokeEvent) => Promise<unknown>,
): void {
  ipcMain.handle(Channels.providers.list, (event): ProviderInfo[] => {
    return getRegistry(event).list()
  })

  ipcMain.handle(Channels.providers.getStatusLine, (event, providerId: string): string => {
    const factory = getRegistry(event).get(providerId)
    if (!factory?.getStatusLine) return ''
    return factory.getStatusLine()
  })

  ipcMain.handle(Channels.providers.setDefault, async (event, providerId: string) => {
    const agentRoot = getAgentRoot(event)
    setAgentConfig(agentRoot, 'system.provider', providerId)
    const state = buildProviderState(agentRoot, getRegistry(event))
    const wc = getRendererWebContents()
    if (wc) pushProviderState(wc, state)
  })

  ipcMain.handle(Channels.providers.switchProvider, async (event, providerId: string) => {
    const agentRoot = getAgentRoot(event)
    setAgentConfig(agentRoot, 'system.provider', providerId)
    await onReconnect(event)
    const state = buildProviderState(agentRoot, getRegistry(event))
    const wc = getRendererWebContents()
    if (wc) pushProviderState(wc, state)
  })
}
