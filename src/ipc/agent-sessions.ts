import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import type { AgentSessionManager } from '../agent/session_manager.js'
import { Channels } from './channels.js'

export function registerAgentSessionHandlers(
  getManager: (e: IpcMainInvokeEvent) => AgentSessionManager,
  onReconnect: (e: IpcMainInvokeEvent) => Promise<AgentSessionManager>,
): void {
  ipcMain.handle(Channels.agent.createSession, async (event, opts?: { label?: string; prompt?: string; providerId?: string }) => {
    if (!opts?.prompt) {
      getManager(event).resetActive()
      return null
    }
    return getManager(event).createSession(opts as { prompt: string; label?: string; providerId?: string })
  })

  ipcMain.handle(Channels.agent.sendMessage, async (event, text: string, options?: { streamingBehavior?: 'followUp' }) => {
    await getManager(event).sendMessage(text, options)
  })

  ipcMain.handle(Channels.agent.abort, async (event) => {
    await getManager(event).abortActive()
  })

  ipcMain.handle(Channels.agent.closeSession, async (event) => {
    await getManager(event).closeActiveSession()
  })

  ipcMain.handle(Channels.agent.loadSession, async (event, file: string) => {
    await getManager(event).openSessionInChat(file)
  })

  ipcMain.handle(Channels.agent.switchTo, async (event, sessionId: string) => {
    getManager(event).switchTo(sessionId)
  })

  ipcMain.handle(Channels.agent.getSessionList, async (event) => {
    return getManager(event).getSessionList()
  })

  ipcMain.handle(Channels.agent.setNotifyOnFinish, async (event, value: boolean) => {
    getManager(event).setNotifyOnFinish(value)
  })

  ipcMain.handle(Channels.agent.reconnect, async (event) => {
    await onReconnect(event)
  })

  ipcMain.handle(Channels.agent.getSnapshot, async (event) => {
    return getManager(event).getSnapshot()
  })

  ipcMain.handle(Channels.agent.spawnSession, async (event, prompt: string) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnSession requires a non-empty prompt string')
    }
    return getManager(event).spawnSession(prompt)
  })

  ipcMain.handle(Channels.agent.sendToSession, async (event, sessionId: string, message: string) => {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty sessionId string')
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty message string')
    }
    await getManager(event).sendToSession(sessionId, message)
  })

  ipcMain.handle(Channels.agent.disposeSession, async (event, file: string) => {
    if (typeof file !== 'string' || file.trim().length === 0) return
    await getManager(event).disposeSessionByFile(file)
  })

  ipcMain.handle(Channels.agent.retryNow, async (event) => {
    getManager(event).skipRetryDelay()
  })
}

/**
 * Set up state streaming from AgentSessionManager to renderer.
 * Call this after creating/reconnecting the session manager.
 *
 * Optimization: only sends the full snapshot (with messages) when non-streaming
 * state changes (session switch, streaming end, etc.). During streaming, only
 * sends the lightweight streaming message on a debounced channel.
 *
 * A periodic heartbeat sends full snapshots every few seconds while any session
 * is streaming, ensuring the renderer stays in sync even during long silent
 * periods (e.g. model thinking with hidden deltas).
 */
export function setupAgentStateStreaming(
  manager: AgentSessionManager,
  wc: WebContents,
  isActive?: () => boolean,
): () => void {
  let streamingDebounce: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let heartbeatDirty = false
  let prevIsStreaming = false
  let prevMessages: unknown = null
  let prevNotifyOnFinish = false

  const sendFullSnapshot = () => {
    if (wc.isDestroyed()) return
    if (!heartbeatDirty) return
    if (isActive && !isActive()) return
    heartbeatDirty = false
    const snapshot = manager.getSnapshot()
    wc.send(Channels.agent.snapshot, snapshot)
    prevIsStreaming = snapshot.isStreaming
    prevMessages = snapshot.messages
    prevNotifyOnFinish = snapshot.notifyOnFinish
  }

  const unsubscribe = manager.subscribe(() => {
    if (wc.isDestroyed()) return
    heartbeatDirty = true

    const snapshot = manager.getSnapshot()

    // Start heartbeat when any session begins streaming
    if ((snapshot.isStreaming || snapshot.streamingSessionsCount > 0) && !heartbeat) {
      heartbeat = setInterval(sendFullSnapshot, 5_000)
    }
    // Stop heartbeat when nothing is streaming
    if (!snapshot.isStreaming && snapshot.streamingSessionsCount === 0 && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }

    // Skip sending to renderer if this agent is not the active one
    if (isActive && !isActive()) return

    if (snapshot.isStreaming) {
      // During streaming, send the lightweight streaming data (debounced)
      if (!streamingDebounce) {
        streamingDebounce = setTimeout(() => {
          streamingDebounce = null
          if (wc.isDestroyed()) return
          if (isActive && !isActive()) return
          const current = manager.getSnapshot()
          wc.send(Channels.agent.streaming, {
            message: current.streamingMessage,
            statusLine: current.statusLine,
            isStreaming: current.isStreaming,
            retryState: current.retryState,
            stalledSince: current.stalledSince,
          })
        }, 16) // ~60fps
      }

      if (!prevIsStreaming || snapshot.messages !== prevMessages || snapshot.notifyOnFinish !== prevNotifyOnFinish) {
        wc.send(Channels.agent.snapshot, snapshot)
      }
    } else {
      wc.send(Channels.agent.snapshot, snapshot)
    }

    prevIsStreaming = snapshot.isStreaming
    prevMessages = snapshot.messages
    prevNotifyOnFinish = snapshot.notifyOnFinish
  })

  return () => {
    unsubscribe()
    if (streamingDebounce) {
      clearTimeout(streamingDebounce)
      streamingDebounce = null
    }
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }
}
