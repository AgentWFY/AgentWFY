import { ipcMain, session } from 'electron';
import { Channels } from './channels.js';

interface SetHeadersRequest {
  tid: string;
  headers: Record<string, string>;
  url?: string;
}

const HEADER_TTL_MS = 30_000;

interface HeaderEntry {
  headers: Record<string, string>;
  createdAt: number;
}

const registeredHeaders = new Map<string, HeaderEntry>();
const requestIdToTid = new Map<number, string>();
// WebSocket URL → HeaderEntry queue (Chromium can't redirect WS, so we match by URL)
const pendingWsHeaders: Map<string, HeaderEntry[]> = new Map();

function purgeStale(): void {
  const now = Date.now();
  for (const [tid, entry] of registeredHeaders) {
    if (now - entry.createdAt > HEADER_TTL_MS) {
      registeredHeaders.delete(tid);
    }
  }
  for (const [url, queue] of pendingWsHeaders) {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (now - queue[i].createdAt > HEADER_TTL_MS) queue.splice(i, 1);
    }
    if (queue.length === 0) pendingWsHeaders.delete(url);
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
    const entry: HeaderEntry = { headers: request.headers, createdAt: Date.now() };
    if (request.url) {
      // WebSocket: store by URL only (Chromium can't redirect WS to strip query params)
      const queue = pendingWsHeaders.get(request.url) || [];
      queue.push(entry);
      pendingWsHeaders.set(request.url, queue);
    } else {
      // Fetch: store by tid (matched via _awfy_id redirect)
      registeredHeaders.set(request.tid, entry);
    }
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
    if (registeredHeaders.size === 0 && pendingWsHeaders.size === 0) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    let tid: string | undefined;

    // For fetch: look up via Chromium request ID (set during onBeforeRequest redirect)
    tid = requestIdToTid.get(details.id);
    if (tid) {
      requestIdToTid.delete(details.id);
    }

    // For WebSocket: match by URL (Chromium can't redirect WS to strip query params)
    if (!tid && details.resourceType === 'webSocket') {
      const queue = pendingWsHeaders.get(details.url);
      if (queue && queue.length > 0) {
        const wsEntry = queue.shift()!;
        if (queue.length === 0) pendingWsHeaders.delete(details.url);
        const requestHeaders = { ...details.requestHeaders };
        for (const [key, value] of Object.entries(wsEntry.headers)) {
          requestHeaders[key] = value;
        }
        return callback({ requestHeaders });
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
