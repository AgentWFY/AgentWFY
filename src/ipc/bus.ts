import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import crypto from 'crypto'
import { Channels } from './channels.js'
import type { AgentSessionManager } from '../agent/session_manager.js'
import type { TaskRunner } from '../task-runner/task_runner.js'

type PendingWaiter = {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
  windowId: number
}

const pendingWaiters = new Map<string, PendingWaiter>()
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

export function registerBusHandlers(
  getWindow: (e: IpcMainInvokeEvent) => BrowserWindow,
  getSessionManager: (e: IpcMainInvokeEvent) => AgentSessionManager,
  getTaskRunner: (e: IpcMainInvokeEvent) => TaskRunner,
): void {
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

  // spawnAgent(prompt) → { agentId } — now calls SessionManager directly
  ipcMain.handle(Channels.bus.spawnAgent, async (event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }

    const mgr = getSessionManager(event)
    return mgr.spawnSession(prompt)
  })

  // sendToAgent(agentId, message) — now calls SessionManager directly
  ipcMain.handle(Channels.bus.sendToAgent, async (event, agentId: string, message: string) => {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty agentId string')
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty message string')
    }

    const mgr = getSessionManager(event)
    await mgr.sendToAgent(agentId, message)
  })

  // Renderer forwards subscribed bus events back to main
  ipcMain.on(Channels.bus.subscribeEvent, (event, payload: { subId: string; data: unknown }) => {
    const sub = activeSubscriptions.get(payload.subId)
    if (!sub || !senderMatchesWindow(event, sub.windowId)) return
    sub.callback(payload.data)
  })
}
