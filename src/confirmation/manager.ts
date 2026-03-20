import { BrowserWindow, nativeTheme } from 'electron'
import path from 'path'
import { pathToFileURL } from 'url'
import { CONFIRMATION_CHANNEL } from './types.js'

export interface ConfirmationManagerDeps {
  getMainWindow: () => BrowserWindow | null
  registerSender?: (webContentsId: number) => void
  unregisterSender?: (webContentsId: number) => void
}

export class ConfirmationManager {
  private window: BrowserWindow | null = null
  private readonly deps: ConfirmationManagerDeps
  private readonly pendingRequests = new Map<string, { resolve: (confirmed: boolean) => void }>()

  constructor(deps: ConfirmationManagerDeps) {
    this.deps = deps
  }

  private resolveBounds(): Electron.Rectangle {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 400, height: 220 }
    }
    const bounds = mainWindow.getBounds()
    const width = 400
    const height = 220
    const x = bounds.x + Math.floor((bounds.width - width) / 2)
    const y = bounds.y + Math.max(40, Math.floor((bounds.height - height) * 0.25))
    return { x, y, width, height }
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window
    }

    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable')
    }

    this.window = new BrowserWindow({
      parent: mainWindow,
      show: false,
      frame: false,
      transparent: false,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      roundedCorners: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f0f0f0',
      webPreferences: {
        preload: path.join(import.meta.dirname, 'confirmation', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: false,
        backgroundThrottling: false,
      },
    })

    if (process.platform === 'darwin') {
      this.window.setAlwaysOnTop(true, 'floating')
      this.window.setWindowButtonVisibility(false)
    }

    this.window.on('blur', () => {
      setTimeout(() => {
        if (!this.window || this.window.isDestroyed() || this.window.isFocused()) return
        this.hide()
      }, 0)
    })

    const wcId = this.window.webContents.id
    this.deps.registerSender?.(wcId)

    this.window.on('closed', () => {
      this.deps.unregisterSender?.(wcId)
      this.window = null
    })

    void this.window.loadURL(pathToFileURL(path.join(import.meta.dirname, 'confirmation.html')).toString())
      .catch((error) => {
        console.error('[confirmation] failed to load confirmation window', error)
      })

    return this.window
  }

  requestConfirmation(screen: string, params: Record<string, unknown>): Promise<boolean> {
    const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<boolean>((resolve) => {
      this.pendingRequests.set(requestId, { resolve })

      const win = this.ensureWindow()
      win.setBounds(this.resolveBounds())
      win.show()
      win.moveTop()
      win.focus()
      win.webContents.focus()

      const notify = () => {
        if (!win.isDestroyed()) {
          win.webContents.send(CONFIRMATION_CHANNEL.SHOW, { screen, params, requestId })
        }
      }

      if (win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', notify)
      } else {
        notify()
      }
    })
  }

  resolveConfirmation(requestId: string, confirmed: boolean): void {
    const entry = this.pendingRequests.get(requestId)
    if (!entry) return
    this.pendingRequests.delete(requestId)
    entry.resolve(confirmed)
    this.hide()
  }

  hide(): void {
    this.rejectAllPending()
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
  }

  destroy(): void {
    this.rejectAllPending()
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
  }

  syncBounds(): void {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return
    this.window.setBounds(this.resolveBounds())
  }

  private rejectAllPending(): void {
    for (const entry of this.pendingRequests.values()) {
      entry.resolve(false)
    }
    this.pendingRequests.clear()
  }
}
