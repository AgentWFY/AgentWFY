interface TabLinkRequest {
  viewId?: string | number
  filePath?: string
  title?: string
  params?: Record<string, string>
}

export function parseTabLink(href: string): TabLinkRequest | null {
  if (!href.startsWith('agentview://')) return null

  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  const hostname = url.hostname
  const rawPath = decodeURIComponent(url.pathname).replace(/^\/+/, '').trim()
  if (!rawPath) return null

  const title = url.searchParams.get('title') || undefined
  const params: Record<string, string> = {}
  url.searchParams.forEach((v, k) => {
    if (k !== 'title') params[k] = v
  })
  const hasParams = Object.keys(params).length > 0

  if (hostname === 'view') {
    return { viewId: rawPath, title, params: hasParams ? params : undefined }
  }
  if (hostname === 'file') {
    return { filePath: rawPath, title, params: hasParams ? params : undefined }
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

