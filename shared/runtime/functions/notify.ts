import type { FunctionRegistry } from '../function_registry.js'
import type { NotificationHost } from '../hosts.js'

// OS banners truncate anyway, and an agent handing a whole file to `notify`
// should get a usable banner rather than a wall of text.
const MAX_TITLE = 100
const MAX_BODY = 500

// Agents run unattended from triggers and tasks, so a loop that notifies on
// every iteration is a plausible mistake. Cap the burst and fail loudly —
// silently dropping would leave the agent believing the user was told.
const RATE_LIMIT_COUNT = 5
const RATE_LIMIT_WINDOW_MS = 10_000

function clamp(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function registerNotify(registry: FunctionRegistry, host: NotificationHost): void {
  let windowStart = 0
  let windowCount = 0

  registry.register('notify', async (params) => {
    const { title, body, silent, bounce } = (params ?? {}) as {
      title?: unknown
      body?: unknown
      silent?: unknown
      bounce?: unknown
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('notify requires a non-empty title string')
    }
    if (body !== undefined && typeof body !== 'string') {
      throw new Error('notify body must be a string when provided')
    }

    const now = Date.now()
    if (now - windowStart > RATE_LIMIT_WINDOW_MS) {
      windowStart = now
      windowCount = 0
    }
    windowCount += 1
    if (windowCount > RATE_LIMIT_COUNT) {
      throw new Error(
        `notify rate limit exceeded (${RATE_LIMIT_COUNT} per ${RATE_LIMIT_WINDOW_MS / 1000}s). `
        + 'Batch updates into one notification instead of notifying per item.',
      )
    }

    host.show({
      title: clamp(title, MAX_TITLE),
      body: typeof body === 'string' ? clamp(body, MAX_BODY) : '',
      silent: silent === true,
    })
    if (bounce === true) host.bounce?.()
  })
}
