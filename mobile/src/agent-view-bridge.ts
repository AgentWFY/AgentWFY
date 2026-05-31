// Bridge between agentview:// iframes and the active backend's FunctionsApi.
//
// Mobile's agentview:// frames cannot use Electron's preload/contextBridge.
// The Rust URI handler injects a tiny script that postMessage()s function
// calls here; this parent-side handler mirrors desktop/ipc/runtime-functions.ts
// by routing through the active backend.

import { backendSession } from './services/backend-session.js'

const AGENT_VIEW_CALL_CHANNEL = 'agentwfy:view-call'
const AGENT_VIEW_RESULT_CHANNEL = 'agentwfy:view-result'

interface AgentViewCallMessage {
  channel: typeof AGENT_VIEW_CALL_CHANNEL
  id: string
  name: string
  params: unknown
}

interface AgentViewErrorPayload {
  name: string
  message: string
}

export function installAgentViewBridge(): void {
  window.addEventListener('message', (event) => {
    const message = parseAgentViewCall(event.data)
    if (!message) return

    const frame = findAgentViewFrameForSource(event.source)
    if (!frame || !isAllowedAgentViewOrigin(event.origin)) {
      console.warn('[mobile-view] rejected message from untrusted source:', event.origin)
      return
    }

    void handleAgentViewCall(frame, event.origin, message)
  })
}

async function handleAgentViewCall(
  frame: HTMLIFrameElement,
  origin: string,
  message: AgentViewCallMessage,
): Promise<void> {
  try {
    const backend = backendSession.getBackend()
    if (!backend) {
      throw new Error('Remote agent is not connected.')
    }

    const available = new Set(backend.functions.getNamesSync())
    if (!available.has(message.name)) {
      throw new Error(`Unknown function: ${message.name}`)
    }

    const value = await backend.functions.invoke({
      name: message.name,
      params: normalizeAgentViewParams(message.name, message.params),
    })
    postAgentViewResult(frame, origin, message.id, { ok: true, value })
  } catch (err) {
    postAgentViewResult(frame, origin, message.id, {
      ok: false,
      error: normalizeAgentViewError(err),
    })
  }
}

function normalizeAgentViewParams(name: string, params: unknown): unknown {
  if (name !== 'openPage' || !params || typeof params !== 'object' || Array.isArray(params)) {
    return params
  }
  const request = { ...params as Record<string, unknown> }
  if (typeof request.display !== 'string') request.display = 'foreground'
  return request
}

function parseAgentViewCall(data: unknown): AgentViewCallMessage | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Partial<AgentViewCallMessage>
  if (raw.channel !== AGENT_VIEW_CALL_CHANNEL) return null
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) return null
  return {
    channel: AGENT_VIEW_CALL_CHANNEL,
    id: raw.id,
    name: raw.name.trim(),
    params: raw.params,
  }
}

function findAgentViewFrameForSource(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source) return null
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe')) {
    if (frame.contentWindow === source && isAgentViewFrame(frame)) {
      return frame
    }
  }
  return null
}

function isAgentViewFrame(frame: HTMLIFrameElement): boolean {
  const src = frame.getAttribute('src') || frame.src
  try {
    const url = new URL(src, window.location.href)
    return url.protocol === 'agentview:' && url.hostname === 'localhost'
  } catch {
    return src.startsWith('agentview://localhost/')
  }
}

function isAllowedAgentViewOrigin(origin: string): boolean {
  // WebKit may report custom schemes as an opaque origin. The iframe source
  // check above is the primary trust boundary in that case.
  return origin === 'agentview://localhost' || origin === 'null'
}

function postAgentViewResult(
  frame: HTMLIFrameElement,
  origin: string,
  id: string,
  result: { ok: true; value: unknown } | { ok: false; error: AgentViewErrorPayload },
): void {
  const target = frame.contentWindow
  if (!target) return
  target.postMessage({
    channel: AGENT_VIEW_RESULT_CHANNEL,
    id,
    ...result,
  }, origin === 'null' ? '*' : origin)
}

function normalizeAgentViewError(err: unknown): AgentViewErrorPayload {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: err.message || 'Unknown error' }
  }
  return { name: 'Error', message: String(err) }
}
