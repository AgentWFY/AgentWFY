import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import type { AgentSessionManager } from '#shared/agent/session_manager.js'
import type { AgentBackend } from '#shared/backend/interface.js'
import type { AgentChatController } from '#shared/agent/chat_controller.js'
import type { AgentSnapshot, ChatStreamingPatch, FileContent } from '#shared/agent/types.js'
import { diffStreamBlocks, mirrorOf, type StreamMirror } from '#shared/agent/stream_delta.js'
import { externalizeBlock, externalizeMessage, externalizeMessages } from '../chat/message-blobs.js'
import { Channels } from './channels.cjs'
import type { PushMap } from './schema.js'

export function registerAgentSessionHandlers(
  onReconnect: (e: IpcMainInvokeEvent) => Promise<AgentSessionManager>,
  getBackend: (e: IpcMainInvokeEvent) => AgentBackend,
  getChat: (e: IpcMainInvokeEvent) => AgentChatController,
  getPump: (e: IpcMainInvokeEvent) => AgentChatPump | null,
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
    // Go through the pump when there is one: it stamps the snapshot with the
    // transcript version and stream sequence the pushed ones carry, so a
    // renderer that pulls (on load, after a reload) lands in the same
    // bookkeeping the pushes assume. Falls back to the raw snapshot when the
    // pump hasn't been built yet.
    return getPump(event)?.snapshotForRenderer() ?? getChat(event).getSnapshot()
  })

  ipcMain.handle(Channels.agent.unloadSession, async (event, sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return
    await getChat(event).unloadSession(sessionId)
  })

  ipcMain.handle(Channels.agent.retryNow, async (event) => {
    await getChat(event).skipRetryDelay()
  })

  ipcMain.handle(Channels.agent.removeQueuedMessage, async (event, index: number) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return
    await getChat(event).removeQueuedMessage(index)
  })
}

export interface AgentChatPump {
  /** Tear down all subscriptions/timers. */
  stop(): void
  /** Force an immediate snapshot push (used when the renderer switches to
   *  this agent and the existing chat state should be re-sent). */
  refresh(): void
  /** Snapshot for a renderer that asked for one, stamped and recorded exactly
   *  as a pushed snapshot would be. */
  snapshotForRenderer(): AgentSnapshot
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
  let prevMessages: AgentSnapshot['messages'] | null = null
  let prevNotifyOnFinish = false
  let prevQueueSig = ''
  let stopped = false

  // Streaming-message bookkeeping. `streamSeq` stamps every payload that
  // carries a whole message; deltas quote the sequence they build on so the
  // renderer can tell a usable delta from one it can't apply. `sentStream`
  // mirrors what the renderer holds, and is only ever advanced at send time —
  // a wakeup whose payload gets debounced away must not move it.
  let streamSeq = 0
  let sentStream: StreamMirror | null = null
  let latestStreamingSnapshot: AgentSnapshot | null = null

  // Identity of the displayed transcript, and a counter the renderer uses to
  // skip rebuilding every message block when the transcript hasn't changed.
  let messagesRef: AgentSnapshot['messages'] | null = null
  let messagesVersion = 0

  // Last snapshot handed to pushFullSnapshot, for the idle-path redundancy
  // check. Sessions other than the displayed one wake the pump on every token
  // they stream; without this, each of those wakeups re-sent the whole
  // transcript even though nothing the renderer shows had changed.
  let lastPushed: AgentSnapshot | null = null

  const send = <C extends keyof PushMap>(channel: C, data: PushMap[C]) => {
    if (!wc.isDestroyed()) wc.send(channel, data)
  }

  // Cheap signature of the queue. Follow-ups only push/shift/remove, so a
  // change always changes the count or per-item shape — no need to hash text.
  const queueSig = (queue: AgentSnapshot['queuedMessages']): string => {
    let sig = String(queue.length)
    for (const item of queue) sig += `|${item.text.length},${item.fileCount}`
    return sig
  }

  // Two transcripts are the same if they're the same array, or if both are
  // empty — a controller with no displayed session rebuilds `[]` on every
  // getSnapshot(), and that must not read as a change.
  const sameMessages = (a: AgentSnapshot['messages'], b: AgentSnapshot['messages']): boolean =>
    a === b || (a.length === 0 && b.length === 0)

  const sameIds = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((id, i) => id === b[i])

  /** True when `next` would render identically to `prev`. Only consulted on the
   *  idle path, where `streamingMessage` is null — a live streaming message
   *  mutates in place, so its reference can't be trusted for equality. */
  const rendersIdentically = (prev: AgentSnapshot, next: AgentSnapshot): boolean =>
    prev.streamingMessage === null
    && next.streamingMessage === null
    && sameMessages(prev.messages, next.messages)
    && prev.isStreaming === next.isStreaming
    && prev.label === next.label
    && prev.streamingSessionsCount === next.streamingSessionsCount
    && prev.notifyOnFinish === next.notifyOnFinish
    && prev.statusLine === next.statusLine
    && prev.providerId === next.providerId
    && prev.activeSessionId === next.activeSessionId
    && prev.retryState === next.retryState
    && prev.stalledSince === next.stalledSince
    && sameIds(prev.streamingSessionIds, next.streamingSessionIds)
    && queueSig(prev.queuedMessages) === queueSig(next.queuedMessages)

  /** Snapshot as the renderer should see it: binaries out of band, stamped
   *  with the transcript version and a fresh stream sequence. Records what was
   *  handed over, so both the idle-path redundancy check and the streaming
   *  differ stay in step with the renderer. */
  const renderSnapshot = (snapshot: AgentSnapshot): AgentSnapshot => {
    streamSeq++
    sentStream = snapshot.streamingMessage ? mirrorOf(snapshot.streamingMessage) : null
    prevIsStreaming = snapshot.isStreaming
    prevMessages = snapshot.messages
    prevNotifyOnFinish = snapshot.notifyOnFinish
    prevQueueSig = queueSig(snapshot.queuedMessages)
    lastPushed = snapshot
    return {
      ...snapshot,
      messages: externalizeMessages(snapshot.messages),
      streamingMessage: externalizeMessage(snapshot.streamingMessage),
      messagesVersion,
      streamSeq,
    }
  }

  const pushFullSnapshot = (snapshot: AgentSnapshot) => {
    send(Channels.agent.snapshot, renderSnapshot(snapshot))
  }

  /** Builds the `agent:streaming` payload at send time (not at wakeup time),
   *  because computing it advances `sentStream`. */
  const streamingPatch = (snapshot: AgentSnapshot): ChatStreamingPatch => {
    const patch: ChatStreamingPatch = {
      statusLine: snapshot.statusLine,
      isStreaming: snapshot.isStreaming,
      retryState: snapshot.retryState,
      stalledSince: snapshot.stalledSince,
    }
    const msg = snapshot.streamingMessage
    if (!msg || !sentStream || sentStream.ref !== msg) {
      // No message, or a message the renderer has never seen — send it whole.
      streamSeq++
      sentStream = msg ? mirrorOf(msg) : null
      patch.streamingMessage = externalizeMessage(msg)
      patch.streamSeq = streamSeq
      return patch
    }
    const ops = diffStreamBlocks(sentStream, msg.blocks, externalizeBlock)
    // Nothing about the message moved: omit both forms so the renderer keeps
    // the object it has and skips a re-render.
    if (ops.length === 0) return patch
    patch.streamingDelta = { base: streamSeq, seq: ++streamSeq, ops }
    sentStream = mirrorOf(msg)
    return patch
  }

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

    if (messagesRef === null || !sameMessages(snapshot.messages, messagesRef)) {
      messagesRef = snapshot.messages
      messagesVersion++
    }

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
      latestStreamingSnapshot = snapshot
      // Lightweight streaming payload — debounced to ~60fps.
      if (!streamingDebounce) {
        streamingDebounce = setTimeout(() => {
          streamingDebounce = null
          if (stopped || wc.isDestroyed()) return
          if (isActive && !isActive()) return
          if (!latestStreamingSnapshot) return
          send(Channels.agent.streaming, streamingPatch(latestStreamingSnapshot))
        }, 16)
      }
      // Send a full snapshot on transitions to-streaming and on message changes
      // mid-stream. The follow-up queue rides on the snapshot (not the
      // lightweight streaming patch), so a queue change also forces one.
      if (
        !prevIsStreaming ||
        snapshot.messages !== prevMessages ||
        snapshot.notifyOnFinish !== prevNotifyOnFinish ||
        queueSig(snapshot.queuedMessages) !== prevQueueSig
      ) {
        pushFullSnapshot(snapshot)
      }
    } else {
      latestStreamingSnapshot = null
      if (lastPushed && rendersIdentically(lastPushed, snapshot)) return
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
      // Clear the change-detection state so the push happens unconditionally —
      // the renderer resets to `ready: false` on agent switch and needs a
      // snapshot back regardless of whether this agent's state moved.
      prevIsStreaming = false
      prevMessages = null
      prevQueueSig = ''
      lastPushed = null
      handleChange()
    },
    snapshotForRenderer() {
      const snapshot = chat.getSnapshot()
      if (messagesRef === null || !sameMessages(snapshot.messages, messagesRef)) {
        messagesRef = snapshot.messages
        messagesVersion++
      }
      return renderSnapshot(snapshot)
    },
  }
}
