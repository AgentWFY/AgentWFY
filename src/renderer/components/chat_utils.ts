import { normalizeAgentViewUrl, isViewHostname, isFileHostname, normalizeViewPathname } from '../../protocol/view-document.js'

interface TabLinkRequest {
  viewName?: string
  filePath?: string
  title?: string
  params?: Record<string, string>
}

export function parseTabLink(href: string): TabLinkRequest | null {
  const url = normalizeAgentViewUrl(href)
  if (!url) return null

  const target = normalizeViewPathname(url.pathname)
  if (!target) return null

  const title = url.searchParams.get('title') || undefined
  const params: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    if (k !== 'title') params[k] = v
  })
  const hasParams = Object.keys(params).length > 0

  if (isViewHostname(url.hostname)) {
    return { viewName: target, title, params: hasParams ? params : undefined }
  }
  if (isFileHostname(url.hostname)) {
    return { filePath: target, title, params: hasParams ? params : undefined }
  }
  return null
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

