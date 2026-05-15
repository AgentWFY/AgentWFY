const _setTimeout = globalThis.setTimeout
const _clearTimeout = globalThis.clearTimeout
const _setInterval = globalThis.setInterval
const _clearInterval = globalThis.clearInterval

type TimerHandle = ReturnType<typeof _setTimeout>

/**
 * Tracks timers created by a plugin so they can be force-cleared on unload,
 * even if the plugin's deactivate() doesn't clean up or throws.
 *
 * Methods are arrow functions so they can be passed as standalone callbacks
 * (e.g. as parameters to new Function() to shadow globals).
 */
export class PluginResourceTracker {
  private readonly timeouts = new Set<TimerHandle>()
  private readonly intervals = new Set<TimerHandle>()

  readonly setTimeout = (callback: (...args: any[]) => void, ms?: number, ...args: any[]): TimerHandle => {
    const id = _setTimeout((...a: any[]) => {
      this.timeouts.delete(id)
      callback(...a)
    }, ms, ...args)
    this.timeouts.add(id)
    return id
  }

  readonly setInterval = (callback: (...args: any[]) => void, ms?: number, ...args: any[]): TimerHandle => {
    const id = _setInterval(callback, ms, ...args)
    this.intervals.add(id)
    return id
  }

  readonly clearTimeout = (id: TimerHandle | undefined): void => {
    if (id !== undefined) this.timeouts.delete(id)
    _clearTimeout(id)
  }

  readonly clearInterval = (id: TimerHandle | undefined): void => {
    if (id !== undefined) this.intervals.delete(id)
    _clearInterval(id)
  }

  /** Force-clear all tracked timers. Returns counts of what was cleaned up. */
  disposeAll(): { timeouts: number; intervals: number } {
    const counts = { timeouts: this.timeouts.size, intervals: this.intervals.size }
    for (const id of this.timeouts) _clearTimeout(id)
    this.timeouts.clear()
    for (const id of this.intervals) _clearInterval(id)
    this.intervals.clear()
    return counts
  }
}
