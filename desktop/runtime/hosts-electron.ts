// Electron-backed implementations of the runtime host interfaces. Lives in
// the Electron side of the codebase (imports `electron`) — the portable
// runtime never references this file.

import { Notification, nativeImage, app, shell, type WebContents } from 'electron'
import path from 'path'
import type { ExternalLauncher, NotificationHost, RendererPush } from '#shared/runtime/hosts.js'

let cachedExternalLauncher: ExternalLauncher | null = null

// A shown Notification is only reachable from native code, so nothing in JS
// keeps it alive between `show()` and the user clicking it — a GC in that
// window would drop the `click` listener. Hold a reference until the OS is
// done with the banner.
const liveNotifications = new Set<Notification>()

function showElectronNotification(opts: {
  title: string
  body: string
  silent?: boolean
  onClick?: () => void
}): void {
  const { title, body, silent, onClick } = opts
  try {
    const icon = nativeImage.createFromPath(
      path.join(import.meta.dirname, '..', '..', 'icons', 'icon.png'),
    )
    const notification = new Notification({ title, body, icon, silent: silent === true })
    liveNotifications.add(notification)
    const release = () => liveNotifications.delete(notification)
    // macOS rejects notifications asynchronously (e.g. `UNErrorDomain
    // error 1` when the app bundle isn't properly signed), so the failure
    // never reaches the catch below.
    notification.on('failed', (_event, error) => {
      release()
      console.warn('[hosts-electron] notification failed:', error)
    })
    notification.on('close', release)
    notification.on('click', () => {
      release()
      try {
        onClick?.()
      } catch (err) {
        console.warn('[hosts-electron] notification click handler failed:', err)
      }
    })
    notification.show()
  } catch (err) {
    console.warn('[hosts-electron] notification not supported:', err)
  }
}

function bounceDock(type: 'informational' | 'critical' = 'informational'): number | null {
  if (process.platform !== 'darwin') return null
  const id = app.dock?.bounce(type)
  return typeof id === 'number' ? id : null
}

function cancelDockBounce(id: number): void {
  if (process.platform !== 'darwin') return
  app.dock?.cancelBounce(id)
}

/**
 * Notification host bound to one agent. Clicking a banner it shows runs
 * `onActivate` — the desktop uses that to focus the window and switch to the
 * agent that fired it, which matters because a background agent's
 * notification is otherwise the only sign it wants attention.
 */
export function createAgentNotificationHost(onActivate: () => void): NotificationHost {
  return {
    show: (opts) => showElectronNotification({ ...opts, onClick: opts.onClick ?? onActivate }),
    bounce: bounceDock,
    cancelBounce: cancelDockBounce,
  }
}

export function getElectronExternalLauncher(): ExternalLauncher {
  if (cachedExternalLauncher) return cachedExternalLauncher
  cachedExternalLauncher = {
    openExternal: (url) => shell.openExternal(url),
  }
  return cachedExternalLauncher
}

/** RendererPush is per-window. Create one bound to the active WebContents. */
export function createElectronRendererPush(wc: WebContents): RendererPush {
  return {
    openSessionInChat: ({ sessionId, label }) => {
      if (wc.isDestroyed()) return
      const detail = JSON.stringify({ sessionId, label }).replace(/</g, '\\u003c')
      wc.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('agentwfy:open-session-in-chat', { detail: ${detail} }));`,
        true,
      ).catch((err) => {
        console.warn('[hosts-electron] rendererPush.openSessionInChat failed:', err)
      })
    },
  }
}
