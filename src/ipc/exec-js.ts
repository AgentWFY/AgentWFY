import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { JsRuntime, type JsRuntimeDeps } from '../runtime/js_runtime.js'
import type { ExecJsLogEntry } from '../runtime/types.js'
import { Channels } from './channels.js'

const runtimes = new Map<number, JsRuntime>()

export function getOrCreateRuntime(win: BrowserWindow, deps: JsRuntimeDeps): JsRuntime {
  let runtime = runtimes.get(win.id)
  if (runtime) return runtime

  runtime = new JsRuntime(deps)
  runtimes.set(win.id, runtime)

  win.on('closed', () => {
    const r = runtimes.get(win.id)
    if (r) {
      r.disposeAll()
      runtimes.delete(win.id)
    }
  })

  return runtime
}

export function registerExecJsHandlers(
  getRuntime: (e: IpcMainInvokeEvent) => JsRuntime,
  getWindow: (e: IpcMainInvokeEvent) => BrowserWindow,
): void {
  ipcMain.handle(Channels.execJs.ensureWorker, (_event, sessionId: string) => {
    const runtime = getRuntime(_event)
    runtime.ensureWorker(sessionId)
  })

  ipcMain.handle(Channels.execJs.terminateWorker, (_event, sessionId: string) => {
    const runtime = getRuntime(_event)
    runtime.terminateWorker(sessionId)
  })

  ipcMain.handle(Channels.execJs.execute, async (event, sessionId: string, code: string, timeoutMs?: number, input?: unknown) => {
    const runtime = getRuntime(event)
    return runtime.executeExecJs(sessionId, code, timeoutMs, undefined, input)
  })

  ipcMain.on(Channels.execJs.cancel, (event, sessionId: string) => {
    try {
      const runtime = getRuntime(event as unknown as IpcMainInvokeEvent)
      runtime.cancelExecution(sessionId)
    } catch {
      // Ignore errors during cancel
    }
  })

  ipcMain.handle(Channels.execJs.watchLogs, (event, sessionId: string) => {
    const runtime = getRuntime(event)
    const win = getWindow(event)
    runtime.watchLogs(sessionId, (entry: ExecJsLogEntry) => {
      if (!win.isDestroyed()) {
        win.webContents.send(Channels.execJs.log, sessionId, entry)
      }
    })
  })

  ipcMain.handle(Channels.execJs.unwatchLogs, (event, sessionId: string) => {
    const runtime = getRuntime(event)
    runtime.unwatchLogs(sessionId)
  })
}
