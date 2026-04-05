import { BaseWindow, WebContentsView } from 'electron'
import path from 'path'
import { pathToFileURL } from 'url'
import { CONFIRMATION_CHANNEL, type ConfirmationResult } from './types.js'

export interface ConfirmationManagerDeps {
  getMainWindow: () => BaseWindow | null
}

export interface ConfirmationOptions {
  width?: number
  height?: number
}

/** Extra padding around the dialog content for the CSS drop-shadow to render. */
const VIEW_PADDING = 40

export class ConfirmationManager {
  private view: WebContentsView | null = null
  private readonly deps: ConfirmationManagerDeps
  private readonly pendingRequests = new Map<string, { resolve: (result: ConfirmationResult) => void }>()
  private sizeOverride: { width: number; height: number } | null = null

  constructor(deps: ConfirmationManagerDeps) {
    this.deps = deps
  }

  getWebContents(): Electron.WebContents | null {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    return this.view.webContents
  }

  isVisible(): boolean {
    return !!this.view && !this.view.webContents.isDestroyed() && this.view.getVisible()
  }

  private resolveContentBounds(): Electron.Rectangle {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { x: 0, y: 0, width: 420, height: 300 }
    }
    const [cw, ch] = mainWindow.getContentSize()
    const width = this.sizeOverride?.width ?? 420
    const height = this.sizeOverride?.height ?? 300
    const x = Math.floor((cw - width) / 2)
    const y = Math.max(40, Math.floor(ch * 0.25))
    return { x, y, width, height }
  }

  private applyBounds(contentBounds: Electron.Rectangle): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.setBounds({
      x: contentBounds.x - VIEW_PADDING,
      y: contentBounds.y - VIEW_PADDING,
      width: contentBounds.width + VIEW_PADDING * 2,
      height: contentBounds.height + VIEW_PADDING * 2,
    })
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view
    }

    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Main window is unavailable')
    }

    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })

    this.view.setBackgroundColor('#00000000')
    this.view.setVisible(false)
    mainWindow.contentView.addChildView(this.view)
    this.applyBounds(this.resolveContentBounds())

    void this.view.webContents.loadURL(pathToFileURL(path.join(import.meta.dirname, '..', 'confirmation.html')).toString())
      .catch((error) => {
        console.error('[confirmation] failed to load confirmation window', error)
      })

    return this.view
  }

  requestConfirmation(screen: string, params: Record<string, unknown>, options?: ConfirmationOptions): Promise<ConfirmationResult> {
    const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.sizeOverride = options?.width || options?.height ? { width: options.width ?? 400, height: options.height ?? 220 } : null
    return new Promise<ConfirmationResult>((resolve) => {
      this.pendingRequests.set(requestId, { resolve })

      const view = this.ensureView()
      this.applyBounds(this.resolveContentBounds())

      // Bring view to top of z-order
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.contentView.removeChildView(view) } catch {}
        mainWindow.contentView.addChildView(view)
      }

      if (!process.env.AGENTWFY_HEADLESS) {
        view.setVisible(true)
      }
      view.webContents.focus()

      const notify = () => {
        if (!view.webContents.isDestroyed()) {
          view.webContents.send(CONFIRMATION_CHANNEL.SHOW, { screen, params, requestId })
        }
      }

      if (view.webContents.isLoadingMainFrame()) {
        view.webContents.once('did-finish-load', notify)
      } else {
        notify()
      }
    })
  }

  resolveConfirmation(requestId: string, confirmed: boolean, data?: Record<string, unknown>): void {
    const entry = this.pendingRequests.get(requestId)
    if (!entry) return
    this.pendingRequests.delete(requestId)
    entry.resolve({ confirmed, data })
    this.hide()
  }

  hide(): void {
    this.rejectAllPending()
    if (this.view && !this.view.webContents.isDestroyed() && this.view.getVisible()) {
      this.view.setVisible(false)
    }
  }

  destroy(): void {
    this.rejectAllPending()
    if (this.view && !this.view.webContents.isDestroyed()) {
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.contentView.removeChildView(this.view) } catch {}
      }
      this.view.webContents.close()
    }
    this.view = null
  }

  syncBounds(): void {
    if (!this.view || this.view.webContents.isDestroyed() || !this.view.getVisible()) return
    this.applyBounds(this.resolveContentBounds())
  }

  private rejectAllPending(): void {
    for (const entry of this.pendingRequests.values()) {
      entry.resolve({ confirmed: false })
    }
    this.pendingRequests.clear()
  }
}
