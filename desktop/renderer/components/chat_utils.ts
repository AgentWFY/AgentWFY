import { parseAgentPath } from '#shared/protocol/view-document.js'

interface TabLinkRequest {
  viewName?: string
  filePath?: string
  title?: string
  params?: Record<string, string>
}

// Parse a markdown link href into a tab-open request.
// Accepts agent-emitted scheme-free paths: "/view/<name>" or "/file/<path>".
// (Agents stay transport-agnostic — they never name a host or scheme.)
export function parseTabLink(href: string): TabLinkRequest | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (!trimmed) return null

  // Reject anything that looks like an absolute URL with a scheme. We only
  // route path-style refs; http(s):// links open externally in the caller.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return null

  // Split off the query string so parseAgentPath sees a clean path. The href
  // comes from the raw markdown so this is always a string, not a parsed URL.
  const queryIdx = trimmed.indexOf('?')
  const pathPart = queryIdx === -1 ? trimmed : trimmed.slice(0, queryIdx)
  const queryPart = queryIdx === -1 ? '' : trimmed.slice(queryIdx + 1)

  const info = parseAgentPath(pathPart)
  if (!info) return null
  if (info.kind !== 'view' && info.kind !== 'file') return null

  const search = new URLSearchParams(queryPart)
  const title = search.get('title') || undefined
  const params: Record<string, string> = {}
  search.forEach((v, k) => {
    if (k !== 'title') params[k] = v
  })
  const hasParams = Object.keys(params).length > 0

  if (info.kind === 'view') {
    return { viewName: info.target, title, params: hasParams ? params : undefined }
  }
  return { filePath: info.target, title, params: hasParams ? params : undefined }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function imageDataUrl(mimeType: string, base64Data: string): string {
  return `data:${escapeHtml(mimeType)};base64,${base64Data}`
}

export const CLOSE_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
export const BACK_ICON_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10 4L6 8l4 4V4z"/></svg>'

/**
 * Wires the "Copy" button UX (clipboard write + transient label/class swap).
 * Caller resolves the text per click so it can read fresh state.
 */
export async function copyToButton(
  btn: HTMLButtonElement,
  text: string,
  copiedLabel = 'Copied',
  restoreLabel = 'Copy',
  restoreMs = 1200,
): Promise<void> {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }
  btn.textContent = copiedLabel
  btn.classList.add('copied')
  setTimeout(() => {
    if (btn.isConnected) {
      btn.textContent = restoreLabel
      btn.classList.remove('copied')
    }
  }, restoreMs)
}

