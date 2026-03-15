import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import crypto from 'crypto'
import { Channels } from './channels.js'
import { forwardBusPublish } from './bus.js'

const activeProcesses = new Map<string, ChildProcess>()

function resolveFfmpegPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const name = `ffmpeg-${process.platform}-${process.arch}${ext}`
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name)
  }
  return path.join(import.meta.dirname, '..', 'resources', 'bin', name)
}

const ffmpegPath = resolveFfmpegPath()

export function killAllFfmpegProcesses(): void {
  for (const child of activeProcesses.values()) {
    child.kill('SIGTERM')
  }
  activeProcesses.clear()
}

export function registerFfmpegHandlers(
  getRoot: (e: IpcMainInvokeEvent) => string,
  getWindow: (e: IpcMainInvokeEvent) => BrowserWindow,
): void {
  ipcMain.handle(Channels.ffmpeg.run, (event, args: string[]) => {
    if (!Array.isArray(args)) {
      throw new Error('ffmpeg requires an args array')
    }

    const id = crypto.randomUUID()
    const cwd = getRoot(event)
    const win = getWindow(event)

    const child = spawn(ffmpegPath, args, { cwd })
    activeProcesses.set(id, child)

    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        if (!win.isDestroyed()) {
          forwardBusPublish(win, `ffmpeg:${id}:output`, { stream, data: chunk.toString() })
        }
      })
    }

    child.on('close', (code, signal) => {
      activeProcesses.delete(id)
      if (!win.isDestroyed()) {
        forwardBusPublish(win, `ffmpeg:${id}:done`, { code, signal })
      }
    })

    child.on('error', (err) => {
      activeProcesses.delete(id)
      if (!win.isDestroyed()) {
        forwardBusPublish(win, `ffmpeg:${id}:done`, { code: null, signal: null, error: err.message })
      }
    })

    return { id }
  })

  ipcMain.handle(Channels.ffmpeg.kill, (_event, id: string) => {
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('ffmpegKill requires a non-empty id string')
    }

    const child = activeProcesses.get(id)
    if (!child) {
      throw new Error(`No active ffmpeg process with id: ${id}`)
    }

    child.kill('SIGTERM')
  })
}
