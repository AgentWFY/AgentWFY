type Waiter = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

const MAX_QUEUE_SIZE = 1000

export class EventBus {
  private queues = new Map<string, unknown[]>()
  private waiters = new Map<string, Waiter[]>()
  private subscribers = new Map<string, Set<(data: unknown) => void>>()

  publish(topic: string, data: unknown): void {
    // Deliver to all persistent subscribers
    const subs = this.subscribers.get(topic)
    if (subs) {
      for (const fn of subs) {
        try {
          fn(data)
        } catch (err) {
          console.error(`[EventBus] subscriber error on topic "${topic}"`, err)
        }
      }
    }

    // If a waiter exists, resolve first waiter
    const topicWaiters = this.waiters.get(topic)
    if (topicWaiters && topicWaiters.length > 0) {
      const waiter = topicWaiters.shift()!
      if (topicWaiters.length === 0) {
        this.waiters.delete(topic)
      }
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(data)
      return
    }

    // Otherwise queue the message, dropping oldest if full
    let queue = this.queues.get(topic)
    if (!queue) {
      queue = []
      this.queues.set(topic, queue)
    }
    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.shift()
    }
    queue.push(data)
  }

  waitFor(topic: string, timeoutMs?: number): Promise<unknown> {
    // Check queue first — if message exists, return immediately
    const queue = this.queues.get(topic)
    if (queue && queue.length > 0) {
      const data = queue.shift()!
      if (queue.length === 0) {
        this.queues.delete(topic)
      }
      return Promise.resolve(data)
    }

    // Otherwise register waiter, block until message or timeout
    return new Promise<unknown>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }

      if (timeoutMs != null && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const topicWaiters = this.waiters.get(topic)
          if (topicWaiters) {
            const idx = topicWaiters.indexOf(waiter)
            if (idx !== -1) {
              topicWaiters.splice(idx, 1)
              if (topicWaiters.length === 0) {
                this.waiters.delete(topic)
              }
            }
          }
          reject(new Error(`Timeout waiting for topic "${topic}"`))
        }, timeoutMs)
      }

      let topicWaiters = this.waiters.get(topic)
      if (!topicWaiters) {
        topicWaiters = []
        this.waiters.set(topic, topicWaiters)
      }
      topicWaiters.push(waiter)
    })
  }

  subscribe(topic: string, fn: (data: unknown) => void): () => void {
    let subs = this.subscribers.get(topic)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(topic, subs)
    }
    subs.add(fn)

    return () => {
      subs!.delete(fn)
      if (subs!.size === 0) {
        this.subscribers.delete(topic)
      }
    }
  }

}

export const bus = new EventBus()
