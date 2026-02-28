import { ipcMain, type BrowserWindow } from 'electron'
import crypto from 'crypto'

type PendingWaiter = {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

export function registerBusHandlers(mainWindow: BrowserWindow): void {
  const pendingWaiters = new Map<string, PendingWaiter>()

  // bus:publish — view publishes → forward to renderer
  ipcMain.handle('bus:publish', async (_event, topic: string, data: unknown) => {
    mainWindow.webContents.send('bus:forward-publish', { topic, data })
  })

  // bus:waitFor — view waits → forward to renderer, store pending promise
  ipcMain.handle('bus:waitFor', async (_event, topic: string, timeoutMs?: number) => {
    const waiterId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            pendingWaiters.delete(waiterId)
            reject(new Error(`Timeout waiting for "${topic}"`))
          }, timeoutMs)
        : null
      pendingWaiters.set(waiterId, { resolve, timer })
      mainWindow.webContents.send('bus:forward-waitFor', { waiterId, topic, timeoutMs })
    })
  })

  // Renderer resolved a waitFor
  ipcMain.on('bus:waitFor-resolved', (_event, payload: { waiterId: string; data: unknown }) => {
    const waiter = pendingWaiters.get(payload.waiterId)
    if (waiter) {
      pendingWaiters.delete(payload.waiterId)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(payload.data)
    }
  })

  // spawnAgent(prompt) → { agentId } — forwarded to renderer for agent creation
  const pendingSpawnRequests = new Map<string, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>()

  ipcMain.handle('agentwfy:spawnAgent', async (_event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }

    const waiterId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSpawnRequests.delete(waiterId)
        reject(new Error('spawnAgent timeout'))
      }, 30_000)
      pendingSpawnRequests.set(waiterId, { resolve, timer })
      mainWindow.webContents.send('agent:forward-spawnAgent', { waiterId, prompt })
    })
  })

  ipcMain.on('agent:spawnAgent-result', (_event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingSpawnRequests.get(payload.waiterId)
    if (pending) {
      pendingSpawnRequests.delete(payload.waiterId)
      clearTimeout(pending.timer)
      pending.resolve(payload.result)
    }
  })
}
