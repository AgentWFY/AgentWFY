import type { PageCloseAfterIdleMs } from './types.js'

export interface IdleCloseEntry {
  closeAfterIdleMs?: PageCloseAfterIdleMs | null
  lastUsedAt?: number
  expiresAt?: number | null
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
