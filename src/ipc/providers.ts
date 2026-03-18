import { ipcMain, type BrowserWindow } from 'electron'
import type { ProviderRegistry } from '../providers/registry.js'
import type {
  ProviderInput,
  ProviderOutput,
  ProviderSession,
  ProviderSessionConfig,
  DisplayMessage,
  ProviderInfo,
} from '../renderer/src/agent/provider_types.js'
import { Channels } from './channels.js'

interface ActiveSession {
  session: ProviderSession
  providerId: string
  listener: (event: ProviderOutput) => void
  windowId: number
}

const sessions = new Map<string, ActiveSession>()
let handleCounter = 0

function generateHandle(): string {
  return `ps_${++handleCounter}_${Date.now()}`
}

function removeSession(handle: string): void {
  const entry = sessions.get(handle)
  if (!entry) return
  entry.session.off(entry.listener)
  sessions.delete(handle)
}

function trackSession(
  session: ProviderSession,
  providerId: string,
  win: BrowserWindow,
): string {
  const handle = generateHandle()

  const listener = (output: ProviderOutput) => {
    if (!win.isDestroyed()) {
      win.webContents.send(Channels.providers.event, handle, output)
    }
    if (output.type === 'done' || output.type === 'error') {
      // Defer removal so the renderer can call getDisplayMessages
      // in response to the done/error event forwarded above.
      setTimeout(() => removeSession(handle), 500)
    }
  }
  session.on(listener)

  sessions.set(handle, { session, providerId, listener, windowId: win.id })
  return handle
}

export function registerProviderHandlers(
  getRegistry: (e: Electron.IpcMainInvokeEvent) => ProviderRegistry,
  getWindow: (e: Electron.IpcMainInvokeEvent) => BrowserWindow,
): void {
  ipcMain.handle(Channels.providers.list, (event): ProviderInfo[] => {
    return getRegistry(event).list()
  })

  ipcMain.handle(Channels.providers.getStatusLine, (event, providerId: string): string => {
    const factory = getRegistry(event).get(providerId)
    if (!factory?.getStatusLine) return ''
    return factory.getStatusLine()
  })

  ipcMain.handle(Channels.providers.createSession, (event, providerId: string, config: ProviderSessionConfig): string => {
    const factory = getRegistry(event).get(providerId)
    if (!factory) throw new Error(`Provider '${providerId}' not found`)
    return trackSession(factory.createSession(config), providerId, getWindow(event))
  })

  ipcMain.handle(Channels.providers.restoreSession, (event, providerId: string, messages: DisplayMessage[], config: ProviderSessionConfig): string => {
    const factory = getRegistry(event).get(providerId)
    if (!factory) throw new Error(`Provider '${providerId}' not found`)
    return trackSession(factory.restoreSession(messages, config), providerId, getWindow(event))
  })

  ipcMain.handle(Channels.providers.send, (_event, handle: string, input: ProviderInput): void => {
    const entry = sessions.get(handle)
    if (!entry) throw new Error(`Session handle '${handle}' not found`)
    entry.session.send(input)
  })

  ipcMain.handle(Channels.providers.getDisplayMessages, async (_event, handle: string): Promise<DisplayMessage[]> => {
    const entry = sessions.get(handle)
    if (!entry) throw new Error(`Session handle '${handle}' not found`)
    return await entry.session.getDisplayMessages()
  })
}

/** Clean up sessions belonging to a specific window. */
export function disposeProviderSessionsForWindow(windowId: number): void {
  for (const [handle, entry] of sessions) {
    if (entry.windowId === windowId) {
      removeSession(handle)
    }
  }
}
