import type {
  PageViewport,
  PageViewportAlias,
  PageViewportInput,
} from './types.js'

const PAGE_VIEWPORT_ALIASES: Record<PageViewportAlias, PageViewport> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 720 },
}

export function resolvePageViewport(input?: PageViewportInput): PageViewport {
  if (typeof input === 'string') {
    return PAGE_VIEWPORT_ALIASES[input] ?? PAGE_VIEWPORT_ALIASES.desktop
  }

  const width = normalizeViewportDimension(input?.width, PAGE_VIEWPORT_ALIASES.desktop.width)
  const height = normalizeViewportDimension(input?.height, PAGE_VIEWPORT_ALIASES.desktop.height)
  return { width, height }
}

export function normalizePageViewportInput(request: {
  viewport?: PageViewportInput
  width?: unknown
  height?: unknown
}): PageViewportInput | undefined {
  if (typeof request.viewport === 'string') return request.viewport

  const hasWidth = request.width !== undefined && request.width !== null
  const hasHeight = request.height !== undefined && request.height !== null
  if (request.viewport || hasWidth || hasHeight) {
    return {
      width: request.viewport?.width ?? (request.width as number | undefined),
      height: request.viewport?.height ?? (request.height as number | undefined),
    }
  }

  return undefined
}

function normalizeViewportDimension(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.floor(parsed))
}
