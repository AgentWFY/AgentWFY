import type {
  ProviderSession,
  ProviderInput,
  ProviderOutput,
  DisplayMessage,
} from './provider_types.js'

/**
 * Renderer-side proxy for a ProviderSession that lives in the main process.
 * Forwards events over IPC.
 */
export class IpcProviderSession implements ProviderSession {
  private handle: string
  private listeners = new Set<(event: ProviderOutput) => void>()
  private ipcCleanup: (() => void) | null = null

  constructor(handle: string) {
    this.handle = handle
    this.setupIpcListener()
  }

  private setupIpcListener(): void {
    const ipc = window.ipc
    if (!ipc?.providers) return

    this.ipcCleanup = ipc.providers.onEvent((eventHandle: string, output: ProviderOutput) => {
      if (eventHandle !== this.handle) return
      for (const listener of this.listeners) {
        listener(output)
      }
    })
  }

  send(event: ProviderInput): void {
    const ipc = window.ipc
    if (!ipc?.providers) {
      throw new Error('Provider IPC not available')
    }
    ipc.providers.send(this.handle, event).catch((err: Error) => {
      // Emit error to listeners
      for (const listener of this.listeners) {
        listener({ type: 'error', error: err.message })
      }
    })
  }

  on(listener: (event: ProviderOutput) => void): void {
    this.listeners.add(listener)
  }

  off(listener: (event: ProviderOutput) => void): void {
    this.listeners.delete(listener)
  }

  async getDisplayMessages(): Promise<DisplayMessage[]> {
    const ipc = window.ipc
    if (!ipc?.providers) {
      throw new Error('Provider IPC not available')
    }
    return ipc.providers.getDisplayMessages(this.handle) as Promise<DisplayMessage[]>
  }

}

/**
 * Create a new provider session via IPC.
 */
export async function createIpcProviderSession(
  providerId: string,
  config: { sessionId: string; systemPrompt: string },
): Promise<IpcProviderSession> {
  const ipc = window.ipc
  if (!ipc?.providers) {
    throw new Error('Provider IPC not available')
  }
  const handle = await ipc.providers.createSession(providerId, config)
  return new IpcProviderSession(handle)
}

/**
 * Restore a provider session from display messages via IPC.
 */
export async function restoreIpcProviderSession(
  providerId: string,
  messages: DisplayMessage[],
  config: { sessionId: string; systemPrompt: string },
): Promise<IpcProviderSession> {
  const ipc = window.ipc
  if (!ipc?.providers) {
    throw new Error('Provider IPC not available')
  }
  const handle = await ipc.providers.restoreSession(providerId, messages, config)
  return new IpcProviderSession(handle)
}
