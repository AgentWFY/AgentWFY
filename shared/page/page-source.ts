import type { PageSource } from './types.js'

export const SUPPORTED_PAGE_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

interface NormalizePageSourceOptions {
  docsHint?: string
}

export function normalizePageSource(value: unknown, options: NormalizePageSourceOptions = {}): PageSource {
  const suffix = options.docsHint ? ` ${options.docsHint}` : ''
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`openPage requires source to be an object.${suffix}`)
  }

  const source = value as Record<string, unknown>
  if (source.type === 'view') {
    if (typeof source.name !== 'string' || source.name.length === 0) {
      throw new Error(`openPage source view requires name.${suffix}`)
    }
    return {
      type: 'view',
      name: source.name,
      ...(source.params !== undefined ? { params: normalizePageSourceParams(source.params, suffix) } : {}),
    }
  }

  if (source.type === 'file') {
    if (typeof source.path !== 'string' || source.path.length === 0) {
      throw new Error(`openPage source file requires path.${suffix}`)
    }
    return {
      type: 'file',
      path: source.path,
      ...(source.params !== undefined ? { params: normalizePageSourceParams(source.params, suffix) } : {}),
    }
  }

  if (source.type === 'url') {
    if (typeof source.url !== 'string' || source.url.length === 0) {
      throw new Error(`openPage source url requires url.${suffix}`)
    }
    validatePageUrlSource(source.url, suffix)
    return { type: 'url', url: source.url }
  }

  throw new Error(`openPage source.type must be "view", "file", or "url".${suffix}`)
}

export function normalizePageSourceParams(value: unknown, suffix = ''): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Page source params must be an object of string values.${suffix}`)
  }
  const out: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') {
      throw new Error(`Page source param "${key}" must be a string.${suffix}`)
    }
    out[key] = rawValue
  }
  return out
}

export function validatePageUrlSource(url: string, suffix = ''): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`openPage source url must be absolute with a scheme (got ${JSON.stringify(url)}).${suffix}`)
  }
  if (!SUPPORTED_PAGE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`openPage source url scheme "${parsed.protocol}" is not supported. Use http(s): or file:.${suffix}`)
  }
  return parsed
}

export function formatPageSource(source: PageSource): string {
  switch (source.type) {
    case 'view':
      return `view "${source.name}"`
    case 'file':
      return `file "${source.path}"`
    case 'url':
      return `url "${source.url}"`
  }
}

export function pageSourceParams(source: PageSource): Record<string, string> | undefined {
  if (source.type === 'url') return undefined
  return source.params
}

export function pageSourceToLegacyTabOpenSource(source: PageSource): { viewName?: string; filePath?: string; url?: string } {
  switch (source.type) {
    case 'view':
      return { viewName: source.name }
    case 'file':
      return { filePath: source.path }
    case 'url':
      return { url: source.url }
  }
}
