import { ipcMain, type BrowserWindow } from 'electron'
import crypto from 'crypto'
import { Channels } from './channels.js'

type PendingWaiter = {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

const pendingWaiters = new Map<string, PendingWaiter>()
const pendingSpawnRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
const activeSubscriptions = new Map<string, (data: unknown) => void>()

export function forwardBusPublish(win: BrowserWindow, topic: string, data: unknown): void {
  win.webContents.send(Channels.bus.forwardPublish, { topic, data })
}

export function forwardBusWaitFor(win: BrowserWindow, topic: string, timeoutMs?: number): Promise<unknown> {
  const waiterId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          pendingWaiters.delete(waiterId)
          reject(new Error(`Timeout waiting for "${topic}"`))
        }, timeoutMs)
      : null
    pendingWaiters.set(waiterId, { resolve, timer })
    win.webContents.send(Channels.bus.forwardWaitFor, { waiterId, topic, timeoutMs })
  })
}

export function forwardBusSubscribe(win: BrowserWindow, topic: string, callback: (data: unknown) => void): string {
  const subId = crypto.randomUUID()
  activeSubscriptions.set(subId, callback)
  win.webContents.send(Channels.bus.forwardSubscribe, { subId, topic })
  return subId
}

export function forwardBusUnsubscribe(win: BrowserWindow, subId: string): void {
  win.webContents.send(Channels.bus.forwardUnsubscribe, { subId })
  activeSubscriptions.delete(subId)
}

export function forwardSpawnAgent(win: BrowserWindow, prompt: string): Promise<{ agentId: string }> {
  const waiterId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSpawnRequests.delete(waiterId)
      reject(new Error('spawnAgent timeout'))
    }, 30_000)
    pendingSpawnRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer })
    win.webContents.send(Channels.bus.forwardSpawnAgent, { waiterId, prompt })
  })
}

export function registerBusHandlers(mainWindow: BrowserWindow): void {
  // bus:publish — view publishes → forward to renderer
  ipcMain.handle(Channels.bus.publish, async (_event, topic: string, data: unknown) => {
    forwardBusPublish(mainWindow, topic, data)
  })

  // bus:waitFor — view waits → forward to renderer, store pending promise
  ipcMain.handle(Channels.bus.waitFor, async (_event, topic: string, timeoutMs?: number) => {
    return forwardBusWaitFor(mainWindow, topic, timeoutMs)
  })

  // Renderer resolved a waitFor
  ipcMain.on(Channels.bus.waitForResolved, (_event, payload: { waiterId: string; data: unknown }) => {
    const waiter = pendingWaiters.get(payload.waiterId)
    if (waiter) {
      pendingWaiters.delete(payload.waiterId)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(payload.data)
    }
  })

  // spawnAgent(prompt) → { agentId } — forwarded to renderer for agent creation
  ipcMain.handle(Channels.bus.spawnAgent, async (_event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }

    return forwardSpawnAgent(mainWindow, prompt)
  })

  ipcMain.on(Channels.bus.spawnAgentResult, (_event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingSpawnRequests.get(payload.waiterId)
    if (pending) {
      pendingSpawnRequests.delete(payload.waiterId)
      clearTimeout(pending.timer)
      pending.resolve(payload.result)
    }
  })

  // Renderer forwards subscribed bus events back to main
  ipcMain.on(Channels.bus.subscribeEvent, (_event, payload: { subId: string; data: unknown }) => {
    const callback = activeSubscriptions.get(payload.subId)
    if (callback) {
      callback(payload.data)
    }
  })
}
