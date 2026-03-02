import { ipcMain, type BrowserWindow } from 'electron'
import crypto from 'crypto'
import { getTaskRunner } from '../task-runner/task-runner'

type PendingWaiter = {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout> | null
}

const pendingWaiters = new Map<string, PendingWaiter>()
const pendingSpawnRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>()

export function forwardBusPublish(win: BrowserWindow, topic: string, data: unknown): void {
  win.webContents.send('bus:forward-publish', { topic, data })
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
    win.webContents.send('bus:forward-waitFor', { waiterId, topic, timeoutMs })
  })
}

export function forwardSpawnAgent(win: BrowserWindow, prompt: string): Promise<{ agentId: string }> {
  const waiterId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSpawnRequests.delete(waiterId)
      reject(new Error('spawnAgent timeout'))
    }, 30_000)
    pendingSpawnRequests.set(waiterId, { resolve: resolve as (value: unknown) => void, reject, timer })
    win.webContents.send('agent:forward-spawnAgent', { waiterId, prompt })
  })
}

export function registerBusHandlers(mainWindow: BrowserWindow): void {
  // bus:publish — view publishes → forward to renderer
  ipcMain.handle('bus:publish', async (_event, topic: string, data: unknown) => {
    forwardBusPublish(mainWindow, topic, data)
  })

  // bus:waitFor — view waits → forward to renderer, store pending promise
  ipcMain.handle('bus:waitFor', async (_event, topic: string, timeoutMs?: number) => {
    return forwardBusWaitFor(mainWindow, topic, timeoutMs)
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
  ipcMain.handle('agentwfy:spawnAgent', async (_event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }

    return forwardSpawnAgent(mainWindow, prompt)
  })

  ipcMain.on('agent:spawnAgent-result', (_event, payload: { waiterId: string; result: unknown }) => {
    const pending = pendingSpawnRequests.get(payload.waiterId)
    if (pending) {
      pendingSpawnRequests.delete(payload.waiterId)
      clearTimeout(pending.timer)
      pending.resolve(payload.result)
    }
  })

  // task:invoke — view calls startTask/stopTask → handled directly by TaskRunner
  ipcMain.handle('task:invoke', async (_event, payload: { method: string; params: Record<string, unknown> }) => {
    const runner = getTaskRunner()
    if (!runner) throw new Error('TaskRunner not initialized')

    switch (payload.method) {
      case 'startTask': {
        const runId = await runner.startTask(payload.params.taskId as number)
        return { runId }
      }
      case 'stopTask': {
        runner.stopTask(payload.params.runId as string)
        return undefined
      }
      default:
        throw new Error(`Unknown task method: ${payload.method}`)
    }
  })
}
