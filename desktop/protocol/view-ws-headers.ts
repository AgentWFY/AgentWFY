import type { Session } from 'electron';

// Chromium stamps `Origin` onto every WebSocket handshake a document opens, and
// `Origin` is a forbidden header, so view JS cannot change it. Views live on the
// agent's pseudo-host (see agent-hostname.ts) — an origin no real service
// allowlists — so origin-checking servers reject their sockets outright. The
// main process can rewrite what the page cannot: `onBeforeSendHeaders` fires for
// ws/wss handshakes and its `requestHeaders` are what actually goes on the wire.
//
// Default: drop `Origin`, matching what Node's WebSocket sends from execJs.
// A view can override per connection via `window.agentwfy.setWsHeaders(...)`,
// which is also the only way to put `Authorization` or a custom `Cookie` on a
// handshake — the browser WebSocket API accepts no headers at all.

const REGISTRATION_TTL_MS = 30_000;

// Registrations are consumed by the handshake they were made for. This cap only
// bounds the leak from views that register and then never open the socket.
const MAX_PENDING_REGISTRATIONS = 64;

// Set by Chromium as part of the upgrade itself. Overriding any of them breaks
// the handshake in ways that are hard to trace back to the override.
const PROTECTED_HEADERS = new Set([
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

export interface ViewWsHeaderRegistration {
  url: string;
  origin?: string;
  headers?: Record<string, string>;
}

interface PendingRegistration {
  /** Headers to set on the handshake. Absence of `Origin` means "send none". */
  headers: Record<string, string>;
  createdAt: number;
}

interface AgentHook {
  session: Session;
  /** Only handshakes carrying this exact Origin are rewritten. */
  viewOrigin: string;
  pending: Map<string, PendingRegistration[]>;
}

const hooks = new Map<string, AgentHook>();

/** ws/wss → http/https so a registration matches whichever form Chromium
 *  reports, and `new URL()` normalizes default ports and empty paths. */
function normalizeWsKey(rawUrl: string): string | null {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) return null;

  let candidate = trimmed;
  if (/^wss:\/\//i.test(candidate)) candidate = `https://${candidate.slice('wss://'.length)}`;
  else if (/^ws:\/\//i.test(candidate)) candidate = `http://${candidate.slice('ws://'.length)}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function countPending(hook: AgentHook): number {
  let total = 0;
  for (const queue of hook.pending.values()) total += queue.length;
  return total;
}

function purgeStale(hook: AgentHook): void {
  const cutoff = Date.now() - REGISTRATION_TTL_MS;
  for (const [key, queue] of hook.pending) {
    const fresh = queue.filter((entry) => entry.createdAt > cutoff);
    if (fresh.length === 0) hook.pending.delete(key);
    else if (fresh.length !== queue.length) hook.pending.set(key, fresh);
  }
}

/** Two sockets can open to the same URL concurrently, so registrations queue
 *  per URL and each handshake consumes one. */
function takePending(hook: AgentHook, requestUrl: string): PendingRegistration | null {
  const key = normalizeWsKey(requestUrl);
  if (!key) return null;

  const queue = hook.pending.get(key);
  if (!queue || queue.length === 0) return null;

  const entry = queue.shift()!;
  if (queue.length === 0) hook.pending.delete(key);
  return entry;
}

function buildHandshakeHeaders(
  hook: AgentHook,
  requestUrl: string,
  requestHeaders: Record<string, string>,
): Record<string, string> {
  purgeStale(hook);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (name.toLowerCase() === 'origin') continue;
    headers[name] = value;
  }

  const pending = takePending(hook, requestUrl);
  if (pending) Object.assign(headers, pending.headers);

  return headers;
}

/** Idempotent — Electron keeps one onBeforeSendHeaders listener per session, so
 *  re-installing for the same agent replaces the previous hook. */
export function installViewWsHeaderHook(options: {
  agentId: string;
  session: Session;
  viewHostname: string;
}): void {
  const hook: AgentHook = {
    session: options.session,
    viewOrigin: `https://${options.viewHostname}`,
    pending: new Map(),
  };
  hooks.set(options.agentId, hook);

  hook.session.webRequest.onBeforeSendHeaders(
    { urls: ['ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      // Tab views share the agent session. A real page's handshake carries its
      // own site as Origin, never the pseudo-host, so this leaves it untouched.
      if (readHeader(details.requestHeaders, 'origin') !== hook.viewOrigin) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({ requestHeaders: buildHandshakeHeaders(hook, details.url, details.requestHeaders) });
    },
  );
}

export function uninstallViewWsHeaderHook(agentId: string): void {
  const hook = hooks.get(agentId);
  if (!hook) return;
  hook.session.webRequest.onBeforeSendHeaders(null);
  hooks.delete(agentId);
}

/** Arm the next handshake to `url` with these headers. Throws on bad input so
 *  the calling view sees the mistake instead of a socket that silently
 *  connects with the wrong headers. */
export function registerViewWsHeaders(agentId: string, request: ViewWsHeaderRegistration): void {
  const hook = hooks.get(agentId);
  if (!hook) {
    throw new Error(`No WebSocket header hook installed for agent ${agentId}`);
  }
  if (!request || typeof request !== 'object') {
    throw new Error('setWsHeaders requires a request object');
  }

  // normalizeWsKey is deliberately lenient about scheme so it can key off
  // whatever form Chromium reports; callers must still name a socket URL.
  const rawUrl = typeof request.url === 'string' ? request.url.trim() : '';
  const key = /^wss?:\/\//i.test(rawUrl) ? normalizeWsKey(rawUrl) : null;
  if (!key) {
    throw new Error('setWsHeaders requires an absolute ws:// or wss:// url');
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value !== 'string') {
      throw new Error(`setWsHeaders header "${name}" must be a string`);
    }
    const lower = name.toLowerCase();
    if (PROTECTED_HEADERS.has(lower)) {
      throw new Error(`setWsHeaders cannot override the "${name}" handshake header`);
    }
    // Origin is spelled out below so `origin` and `headers.Origin` can't disagree.
    if (lower === 'origin') {
      throw new Error('setWsHeaders takes the origin as its own `origin` field');
    }
    headers[name] = value;
  }

  if (request.origin !== undefined) {
    if (typeof request.origin !== 'string' || request.origin.trim().length === 0) {
      throw new Error('setWsHeaders origin must be a non-empty string');
    }
    headers.Origin = request.origin;
  }

  purgeStale(hook);
  if (countPending(hook) >= MAX_PENDING_REGISTRATIONS) {
    throw new Error('Too many unconsumed setWsHeaders registrations; open the sockets you registered');
  }

  const queue = hook.pending.get(key) ?? [];
  queue.push({ headers, createdAt: Date.now() });
  hook.pending.set(key, queue);
}
