import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import type { AgentSessionManager } from '#shared/agent/session_manager.js'
import type { AgentBackend } from '#shared/backend/interface.js'
import type { AgentChatController } from '#shared/agent/chat_controller.js'
import type { AgentSnapshot, FileContent } from '#shared/agent/types.js'
import { Channels } from './channels.cjs'
import type { PushMap } from './schema.js'

export function registerAgentSessionHandlers(
  onReconnect: (e: IpcMainInvokeEvent) => Promise<AgentSessionManager>,
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
  getChat: (e: IpcMainInvokeEvent) => AgentChatController,
): void {
  ipcMain.handle(Channels.agent.createSession, async (event, opts?: { label?: string; prompt?: string; providerId?: string; files?: FileContent[] }) => {
    return getChat(event).createSession({
      label: opts?.label,
      prompt: opts?.prompt,
      providerId: opts?.providerId,
      files: opts?.files,
    })
  })

  ipcMain.handle(Channels.agent.sendMessage, async (event, text: string, options?: { streamingBehavior?: 'followUp'; files?: FileContent[] }) => {
    await getChat(event).sendMessage(text, options)
  })

  ipcMain.handle(Channels.agent.abort, async (event) => {
    await getChat(event).abort()
  })

  ipcMain.handle(Channels.agent.closeSession, async (event) => {
    await getChat(event).closeSession()
  })

  ipcMain.handle(Channels.agent.loadSession, async (event, file: string) => {
    await getChat(event).loadSession(file)
  })

  ipcMain.handle(Channels.agent.switchTo, async (event, sessionId: string) => {
    await getChat(event).switchTo(sessionId)
  })

  ipcMain.handle(Channels.agent.getSessionList, async (event) => {
    return getChat(event).getSessionList()
  })

  ipcMain.handle(Channels.agent.setNotifyOnFinish, async (event, value: boolean) => {
    await getChat(event).setNotifyOnFinish(value)
  })

  ipcMain.handle(Channels.agent.reconnect, async (event) => {
    const backend = getBackend(event)
    if (backend.kind === 'local') {
      await onReconnect(event)
      return
    }
    // Remote backends own their connection lifecycle; just nudge the chat.
    const chat = getChat(event)
    const current = chat.getDisplayedSessionId()
    await chat.setDisplayedSessionId(current)
  })

  ipcMain.handle(Channels.agent.getSnapshot, async (event) => {
    return getChat(event).getSnapshot()
  })

  ipcMain.handle(Channels.agent.spawnSession, async (event, prompt: string, providerId?: string, providerOptions?: Record<string, unknown>) => {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('spawnSession requires a non-empty prompt string')
    }
    const result = await getBackend(event).sessions.spawn({ prompt, providerId, providerOptions })
    // Pin the new session to the chat panel so its events flow through to the renderer.
    await getChat(event).setDisplayedSessionId(result.sessionId)
    return result
  })

  ipcMain.handle(Channels.agent.sendToSession, async (event, sessionId: string, message: string) => {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty sessionId string')
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty message string')
    }
    await getChat(event).setDisplayedSessionId(sessionId)
    await getBackend(event).sessions.send({ sessionId, text: message })
  })

  ipcMain.handle(Channels.agent.disposeSession, async (event, file: string) => {
    if (typeof file !== 'string' || file.trim().length === 0) return
    await getChat(event).disposeSessionByFile(file)
  })

  ipcMain.handle(Channels.agent.retryNow, async (event) => {
    await getChat(event).skipRetryDelay()
  })
}

export interface AgentChatPump {
  /** Tear down all subscriptions/timers. */
  stop(): void
  /** Force an immediate snapshot push (used when the renderer switches to
   *  this agent and the existing chat state should be re-sent). */
  refresh(): void
}

/**
 * Unified snapshot/streaming pump for the chat panel.
 *
 * Subscribes to `chat.subscribe(...)` — both chat controllers fire it
 * whenever chat-visible state may have changed (new message, streaming
 * toggle, displayed session change, connection status change). The pump
 * pulls a fresh snapshot via `chat.getSnapshot()` and pushes
 * snapshot/streaming updates to the renderer using the same throttling
 * and heartbeat strategy that local agents have always used.
 *
 * - Snapshots are sent on every non-streaming change (session switch,
 *   streaming end, etc.) and on message changes mid-stream.
 * - Streaming-update payloads are debounced to ~60fps so partial-token
 *   updates don't flood IPC.
 * - While streaming, a 5s heartbeat pushes a full snapshot so the renderer
 *   stays in sync during long silent periods.
 */
export function setupAgentChatPump(
  chat: AgentChatController,
  wc: WebContents,
  isActive?: () => boolean,
): AgentChatPump {
  let streamingDebounce: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let heartbeatDirty = false
  let prevIsStreaming = false
  let prevMessages: unknown = null
  let prevNotifyOnFinish = false
  let pendingSnapshotFetch = false
  let stopped = false

  const send = <C extends keyof PushMap>(channel: C, data: PushMap[C]) => {
    if (!wc.isDestroyed()) wc.send(channel, data)
  }

  const pushFullSnapshot = (snapshot: AgentSnapshot) => {
    send(Channels.agent.snapshot, snapshot)
    prevIsStreaming = snapshot.isStreaming
    prevMessages = snapshot.messages
    prevNotifyOnFinish = snapshot.notifyOnFinish
  }

  const tickHeartbeat = async () => {
    if (stopped || wc.isDestroyed()) return
    if (!heartbeatDirty) return
    if (isActive && !isActive()) return
    heartbeatDirty = false
    try {
      const snapshot = await chat.getSnapshot()
      if (stopped || wc.isDestroyed()) return
      pushFullSnapshot(snapshot)
    } catch (err) {
      console.warn('[chat-pump] heartbeat snapshot failed:', err)
    }
  }

  const handleChange = async () => {
    if (stopped || wc.isDestroyed()) return
    if (pendingSnapshotFetch) return
    pendingSnapshotFetch = true

    let snapshot: AgentSnapshot
    try {
      snapshot = await chat.getSnapshot()
    } catch (err) {
      pendingSnapshotFetch = false
      console.warn('[chat-pump] getSnapshot failed:', err)
      return
    } finally {
      pendingSnapshotFetch = false
    }

    if (stopped || wc.isDestroyed()) return
    heartbeatDirty = true

    // Manage heartbeat lifecycle around streaming state.
    if ((snapshot.isStreaming || snapshot.streamingSessionsCount > 0) && !heartbeat) {
      heartbeat = setInterval(() => { void tickHeartbeat() }, 5_000)
    }
    if (!snapshot.isStreaming && snapshot.streamingSessionsCount === 0 && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }

    if (isActive && !isActive()) return

    if (snapshot.isStreaming) {
      // Lightweight streaming payload — debounced to ~60fps.
      if (!streamingDebounce) {
        streamingDebounce = setTimeout(async () => {
          streamingDebounce = null
          if (stopped || wc.isDestroyed()) return
          if (isActive && !isActive()) return
          try {
            const current = await chat.getSnapshot()
            send(Channels.agent.streaming, {
              message: current.streamingMessage,
              statusLine: current.statusLine,
              isStreaming: current.isStreaming,
              retryState: current.retryState,
              stalledSince: current.stalledSince,
            })
          } catch (err) {
            console.warn('[chat-pump] streaming snapshot failed:', err)
          }
        }, 16)
      }
      // Send a full snapshot on transitions to-streaming and on message changes mid-stream.
      if (!prevIsStreaming || snapshot.messages !== prevMessages || snapshot.notifyOnFinish !== prevNotifyOnFinish) {
        pushFullSnapshot(snapshot)
      }
    } else {
      pushFullSnapshot(snapshot)
    }
  }

  const onChange = (): void => { void handleChange() }
  const unsubscribe = chat.subscribe(onChange)

  return {
    stop() {
      stopped = true
      unsubscribe()
      if (streamingDebounce) {
        clearTimeout(streamingDebounce)
        streamingDebounce = null
      }
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    },
    refresh() {
      void handleChange()
    },
  }
}
