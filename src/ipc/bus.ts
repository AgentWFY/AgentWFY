import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import crypto from 'crypto'
import { Channels } from './channels.js'

type PendingWaiter = {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
  windowId: number
}

const pendingWaiters = new Map<string, PendingWaiter>()
const pendingSpawnRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; windowId: number }>()
const pendingSendToAgentRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; windowId: number }>()
const activeSubscriptions = new Map<string, { callback: (data: unknown) => void; windowId: number }>()

function senderMatchesWindow(event: Electron.IpcMainEvent, expectedWindowId: number): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  return !win || win.id === expectedWindowId
}

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
    pendingWaiters.set(waiterId, { resolve, timer, windowId: win.id })
    win.webContents.send(Channels.bus.forwardWaitFor, { waiterId, topic, timeoutMs })
  })
}

export function forwardBusSubscribe(win: BrowserWindow, topic: string, callback: (data: unknown) => void): string {
  const subId = crypto.randomUUID()
  activeSubscriptions.set(subId, { callback, windowId: win.id })
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
    pendingSpawnRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer, windowId: win.id })
    win.webContents.send(Channels.bus.forwardSpawnAgent, { waiterId, prompt })
  })
}

export function forwardSendToAgent(win: BrowserWindow, agentId: string, message: string): Promise<void> {
  const waiterId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSendToAgentRequests.delete(waiterId)
      reject(new Error('sendToAgent timeout'))
    }, 120_000)
    pendingSendToAgentRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer, windowId: win.id })
    win.webContents.send(Channels.bus.forwardSendToAgent, { waiterId, agentId, message })
  })
}

export function registerBusHandlers(getWindow: (e: IpcMainInvokeEvent) => BrowserWindow): void {
  // bus:publish — view publishes → forward to renderer
  ipcMain.handle(Channels.bus.publish, async (event, topic: string, data: unknown) => {
    forwardBusPublish(getWindow(event), topic, data)
  })

  // bus:waitFor — view waits → forward to renderer, store pending promise
  ipcMain.handle(Channels.bus.waitFor, async (event, topic: string, timeoutMs?: number) => {
    return forwardBusWaitFor(getWindow(event), topic, timeoutMs)
  })

  // Renderer resolved a waitFor
  ipcMain.on(Channels.bus.waitForResolved, (event, payload: { waiterId: string; data: unknown }) => {
    const waiter = pendingWaiters.get(payload.waiterId)
    if (!waiter || !senderMatchesWindow(event, waiter.windowId)) return
    pendingWaiters.delete(payload.waiterId)
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve(payload.data)
  })

  // spawnAgent(prompt) → { agentId } — forwarded to renderer for agent creation
  ipcMain.handle(Channels.bus.spawnAgent, async (event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }

    return forwardSpawnAgent(getWindow(event), prompt)
  })

  ipcMain.on(Channels.bus.spawnAgentResult, (event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingSpawnRequests.get(payload.waiterId)
    if (!pending || !senderMatchesWindow(event, pending.windowId)) return
    pendingSpawnRequests.delete(payload.waiterId)
    clearTimeout(pending.timer)
    pending.resolve(payload.result)
  })

  // sendToAgent(agentId, message) — forwarded to renderer
  ipcMain.handle(Channels.bus.sendToAgent, async (event, agentId: string, message: string) => {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty agentId string')
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty message string')
    }

    return forwardSendToAgent(getWindow(event), agentId, message)
  })

  ipcMain.on(Channels.bus.sendToAgentResult, (event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingSendToAgentRequests.get(payload.waiterId)
    if (!pending || !senderMatchesWindow(event, pending.windowId)) return
    pendingSendToAgentRequests.delete(payload.waiterId)
    clearTimeout(pending.timer)
    const result = payload.result as { error?: string } | undefined
    if (result?.error) {
      pending.reject(new Error(result.error))
    } else {
      pending.resolve(undefined)
    }
  })

  // Renderer forwards subscribed bus events back to main
  ipcMain.on(Channels.bus.subscribeEvent, (event, payload: { subId: string; data: unknown }) => {
    const sub = activeSubscriptions.get(payload.subId)
    if (!sub || !senderMatchesWindow(event, sub.windowId)) return
    sub.callback(payload.data)
  })
}
