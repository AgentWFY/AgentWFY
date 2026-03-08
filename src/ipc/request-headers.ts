import { ipcMain, session } from 'electron';
import { Channels } from './channels.js';

interface SetHeadersRequest {
  tid: string;
  headers: Record<string, string>;
}

const HEADER_TTL_MS = 30_000;

interface HeaderEntry {
  headers: Record<string, string>;
  createdAt: number;
}

const registeredHeaders = new Map<string, HeaderEntry>();
const requestIdToTid = new Map<number, string>();

function purgeStale(): void {
  const now = Date.now();
  for (const [tid, entry] of registeredHeaders) {
    if (now - entry.createdAt > HEADER_TTL_MS) {
      registeredHeaders.delete(tid);
    }
  }
  // requestIdToTid entries should be consumed within milliseconds;
  // if the map grows beyond a threshold, something went wrong — clear it.
  if (requestIdToTid.size > 100) {
    requestIdToTid.clear();
  }
}

export function registerRequestHeadersHandlers(): void {
  ipcMain.handle(Channels.headers.set, (_event, request: SetHeadersRequest) => {
    if (!request || typeof request.tid !== 'string' || !request.headers || typeof request.headers !== 'object') {
      throw new Error('headers:set requires tid and headers');
    }
    purgeStale();
    registeredHeaders.set(request.tid, { headers: request.headers, createdAt: Date.now() });
  });
}

// Must be called after app is ready (session.defaultSession requires it)
export function installWebRequestHooks(): void {
  const ses = session.defaultSession;

  // For non-WS requests with _awfy_id: extract tid, store mapping, redirect to clean URL
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.resourceType === 'webSocket' || !details.url.includes('_awfy_id=')) {
      return callback({});
    }

    const url = new URL(details.url);
    const tid = url.searchParams.get('_awfy_id');
    if (!tid || !registeredHeaders.has(tid)) {
      return callback({});
    }

    requestIdToTid.set(details.id, tid);

    url.searchParams.delete('_awfy_id');
    callback({ redirectURL: url.toString() });
  });

  // Inject registered headers for both fetch (via requestIdToTid) and WebSocket (via URL param)
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    // Fast exit: nothing registered
    if (registeredHeaders.size === 0) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    let tid: string | undefined;

    // For fetch: look up via Chromium request ID (set during onBeforeRequest redirect)
    tid = requestIdToTid.get(details.id);
    if (tid) {
      requestIdToTid.delete(details.id);
    }

    // For WebSocket: extract from URL directly (no redirect happened)
    if (!tid && details.resourceType === 'webSocket' && details.url.includes('_awfy_id=')) {
      try {
        const url = new URL(details.url);
        tid = url.searchParams.get('_awfy_id') || undefined;
      } catch {
        // ignore malformed URLs
      }
    }

    if (!tid) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const entry = registeredHeaders.get(tid);
    registeredHeaders.delete(tid);

    if (!entry) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const requestHeaders = { ...details.requestHeaders };
    for (const [key, value] of Object.entries(entry.headers)) {
      requestHeaders[key] = value;
    }

    callback({ requestHeaders });
  });
}
