import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import type { AgentSessionManager } from '#shared/agent/session_manager.js'
import type { AgentBackend } from '#shared/backend/interface.js'
import type { AgentChatController } from '#shared/agent/chat_controller.js'
import type { AgentSnapshot, FileContent, SessionLivePatch } from '#shared/agent/types.js'
import { Channels } from './channels.cjs'
import type { PushMap } from './schema.js'

export function registerAgentSessionHandlers(
  onReconnect: (e: IpcMainInvokeEvent) => Promise<AgentSessionManager>,
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
  getChat: (e: IpcMainInvokeEvent) => AgentChatController,
): void {
  ipcMain.handle(Channels.agent.createSession, async (event, opts?: { label?: string; prompt?: string; providerId?: string; providerOptions?: Record<string, unknown>; files?: FileContent[] }) => {
    return getChat(event).createSession({
      label: opts?.label,
      prompt: opts?.prompt,
      providerId: opts?.providerId,
      providerOptions: opts?.providerOptions,
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

  ipcMain.handle(Channels.agent.loadSession, async (event, sessionId: string) => {
    await getChat(event).loadSession(sessionId)
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

  ipcMain.handle(Channels.agent.unloadSession, async (event, sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return
    await getChat(event).unloadSession(sessionId)
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
  let latestStreamingUpdate: SessionLivePatch | null = null
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

  const streamingUpdateFromSnapshot = (snapshot: AgentSnapshot): SessionLivePatch => ({
    streamingMessage: snapshot.streamingMessage,
    statusLine: snapshot.statusLine,
    isStreaming: snapshot.isStreaming,
    retryState: snapshot.retryState,
    stalledSince: snapshot.stalledSince,
  })

  const tickHeartbeat = () => {
    if (stopped || wc.isDestroyed()) return
    if (!heartbeatDirty) return
    if (isActive && !isActive()) return
    heartbeatDirty = false
    try {
      const snapshot = chat.getSnapshot()
      if (stopped || wc.isDestroyed()) return
      pushFullSnapshot(snapshot)
    } catch (err) {
      console.warn('[chat-pump] heartbeat snapshot failed:', err)
    }
  }

  const handleChange = () => {
    if (stopped || wc.isDestroyed()) return

    let snapshot: AgentSnapshot
    try {
      snapshot = chat.getSnapshot()
    } catch (err) {
      console.warn('[chat-pump] getSnapshot failed:', err)
      return
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
      latestStreamingUpdate = streamingUpdateFromSnapshot(snapshot)
      // Lightweight streaming payload — debounced to ~60fps.
      if (!streamingDebounce) {
        streamingDebounce = setTimeout(() => {
          streamingDebounce = null
          if (stopped || wc.isDestroyed()) return
          if (isActive && !isActive()) return
          if (!latestStreamingUpdate) return
          send(Channels.agent.streaming, latestStreamingUpdate)
        }, 16)
      }
      // Send a full snapshot on transitions to-streaming and on message changes mid-stream.
      if (!prevIsStreaming || snapshot.messages !== prevMessages || snapshot.notifyOnFinish !== prevNotifyOnFinish) {
        pushFullSnapshot(snapshot)
      }
    } else {
      latestStreamingUpdate = null
      pushFullSnapshot(snapshot)
    }
  }

  const onChange = (): void => { handleChange() }
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
