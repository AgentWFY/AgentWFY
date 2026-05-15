// Electron-backed implementations of the runtime host interfaces. Lives in
// the Electron side of the codebase (imports `electron`) — the portable
// runtime never references this file.

import { Notification, nativeImage, app, shell, type WebContents } from 'electron'
import path from 'path'
import type { ExternalLauncher, NotificationHost, RendererPush } from '#shared/runtime/hosts.js'

let cachedNotificationHost: NotificationHost | null = null
let cachedExternalLauncher: ExternalLauncher | null = null

export function getElectronNotificationHost(): NotificationHost {
  if (cachedNotificationHost) return cachedNotificationHost
  cachedNotificationHost = {
    show: ({ title, body }) => {
      try {
        const icon = nativeImage.createFromPath(
          path.join(import.meta.dirname, '..', '..', 'icons', 'icon.png'),
        )
        new Notification({ title, body, icon }).show()
      } catch {
        // Notifications may not be supported
      }
    },
    bounce: () => {
      if (process.platform === 'darwin') {
        app.dock?.bounce('informational')
      }
    },
  }
  return cachedNotificationHost
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
