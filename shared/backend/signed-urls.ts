// Stateless signed URLs for browser-direct static fetches against the daemon.
//
// Pattern: the desktop URI handler (or mobile Tauri handler) mints a short-
// lived signed URL and redirects the browser to it; the daemon's HTTP route
// recomputes the HMAC and serves bytes if it matches. No cookies, no daemon
// session state. The agent token is the HMAC key — anyone who already holds
// the token can mint URLs, so the URL leaks nothing they couldn't already do.
//
// Used by:
//   - remote-backend-server/src/index.ts (verify side)
//   - desktop/protocol/file-source.ts (sign side)
//   - mobile/src-tauri/src/view_protocol.rs reimplements this in Rust; keep
//     the wire format in sync if the signing string changes.

import { createHmac, timingSafeEqual } from 'crypto'

export const SIGNED_URL_PATH_PREFIX = '/agent' as const
export const DEFAULT_SIGNED_URL_TTL_MS = 60_000 as const

/** Encode a relative agent file path for URL placement without touching
 *  the slashes between segments — keeps URLs readable in logs. */
export function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

export function decodeRelPath(encoded: string): string {
  return encoded.split('/').map(decodeURIComponent).join('/')
}

function signingString(method: string, agentId: string, relPath: string, exp: number): string {
  return `${method}\n${agentId}\n${relPath}\n${exp}`
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export interface SignFileUrlOptions {
  daemonBaseUrl: string
  agentId: string
  token: string
  path: string
  ttlMs?: number
  now?: number
}

export function signFileUrl(opts: SignFileUrlOptions): string {
  const ttlMs = opts.ttlMs ?? DEFAULT_SIGNED_URL_TTL_MS
  const now = opts.now ?? Date.now()
  const exp = Math.floor((now + ttlMs) / 1000)
  const sig = hmacHex(opts.token, signingString('GET', opts.agentId, opts.path, exp))
  const base = opts.daemonBaseUrl.replace(/\/$/, '')
  const encodedAgent = encodeURIComponent(opts.agentId)
  const encodedPath = encodeRelPath(opts.path)
  return `${base}${SIGNED_URL_PATH_PREFIX}/${encodedAgent}/files/${encodedPath}?sig=${sig}&exp=${exp}`
}

export interface VerifyFileUrlOptions {
  agentId: string
  token: string
  method: string
  path: string
  sig: string
  exp: number
  now?: number
}

export function verifyFileUrl(opts: VerifyFileUrlOptions): boolean {
  const now = opts.now ?? Date.now()
  if (!Number.isFinite(opts.exp) || opts.exp * 1000 <= now) return false
  const expected = hmacHex(opts.token, signingString(opts.method, opts.agentId, opts.path, opts.exp))
  if (expected.length !== opts.sig.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(opts.sig, 'hex'))
  } catch {
    return false
  }
}
