import type { PageCloseAfterIdleMs } from './types.js'

export const DEFAULT_PAGE_CLOSE_AFTER_IDLE_MS = 30 * 60 * 1000
export const MAX_PAGE_CLOSE_AFTER_IDLE_MS = 2_147_483_647

export interface IdleCloseEntry {
  closeAfterIdleMs?: PageCloseAfterIdleMs | null
  lastUsedAt?: number
  expiresAt?: number | null
}

export function resolvePageCloseAfterIdleMs(input?: unknown): PageCloseAfterIdleMs {
  if (input === undefined || input === null) {
    return DEFAULT_PAGE_CLOSE_AFTER_IDLE_MS
  }

  if (input === 'never') {
    return 'never'
  }

  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('closeAfterIdleMs must be a positive number of milliseconds or "never"')
  }

  const value = Math.floor(input)
  if (value <= 0) {
    throw new Error('closeAfterIdleMs must be greater than 0, or "never"')
  }
  if (value > MAX_PAGE_CLOSE_AFTER_IDLE_MS) {
    throw new Error(`closeAfterIdleMs must be <= ${MAX_PAGE_CLOSE_AFTER_IDLE_MS}, or "never"`)
  }
  return value
}

interface IdleCloseSchedulerOptions<T extends IdleCloseEntry> {
  getEntry(id: string): T | null | undefined
  closeEntry(id: string): Promise<void> | void
  onAutoCloseError?: (id: string, error: unknown) => void
}

export class IdleCloseScheduler<T extends IdleCloseEntry> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly options: IdleCloseSchedulerOptions<T>

  constructor(options: IdleCloseSchedulerOptions<T>) {
    this.options = options
  }

  schedule(id: string): void {
    this.clear(id)

    const entry = this.options.getEntry(id)
    if (!entry || typeof entry.closeAfterIdleMs !== 'number') return

    const lastUsedAt = typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : Date.now()
    const expiresAt = lastUsedAt + entry.closeAfterIdleMs
    entry.lastUsedAt = lastUsedAt
    entry.expiresAt = expiresAt

    const timer = setTimeout(() => {
      const current = this.options.getEntry(id)
      if (!current || typeof current.closeAfterIdleMs !== 'number') return

      const currentLastUsedAt = typeof current.lastUsedAt === 'number' ? current.lastUsedAt : lastUsedAt
      const currentExpiresAt = currentLastUsedAt + current.closeAfterIdleMs
      if (Date.now() < currentExpiresAt) {
        current.expiresAt = currentExpiresAt
        this.schedule(id)
        return
      }

      this.timers.delete(id)
      Promise.resolve(this.options.closeEntry(id)).catch((error: unknown) => {
        this.options.onAutoCloseError?.(id, error)
      })
    }, Math.max(1, expiresAt - Date.now()))
    this.timers.set(id, timer)
  }

  touch(id: string, now = Date.now()): T | null {
    const entry = this.options.getEntry(id)
    if (!entry) return null
    entry.lastUsedAt = now
    if (typeof entry.closeAfterIdleMs === 'number') {
      entry.expiresAt = now + entry.closeAfterIdleMs
      this.schedule(id)
    }
    return entry
  }

  clear(id: string): void {
    const timer = this.timers.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(id)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}
