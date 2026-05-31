import type { PageCdpBufferedEvent, PageCdpPollResult, PageCdpSubscription } from './types.js'

export const PAGE_CDP_SUBSCRIPTION_BUFFER_MAX = 1000
export const PAGE_CDP_POLL_MAX_WAIT_MS = 60_000

interface PollWaiter {
  resolve: () => void
  timer?: ReturnType<typeof setTimeout>
}

interface PageCdpSubscriptionManagerOptions {
  bufferMax?: number
  maxWaitMs?: number
}

interface SubscribeRequest {
  subscriptionId: string
  pageId: string
  events: string[]
}

export class PageCdpEventBuffer implements PageCdpSubscription {
  readonly subscriptionId: string
  readonly pageId: string
  private readonly events: Set<string>
  private readonly bufferMax: number
  private readonly pollMaxWaitMs: number
  private readonly buffer: PageCdpBufferedEvent[] = []
  private dropped = 0
  private closed = false
  private waiter: PollWaiter | null = null

  constructor(request: SubscribeRequest, options: PageCdpSubscriptionManagerOptions = {}) {
    this.subscriptionId = request.subscriptionId
    this.pageId = request.pageId
    this.events = new Set(request.events)
    this.bufferMax = options.bufferMax ?? PAGE_CDP_SUBSCRIPTION_BUFFER_MAX
    this.pollMaxWaitMs = options.maxWaitMs ?? PAGE_CDP_POLL_MAX_WAIT_MS
  }

  accepts(event: PageCdpBufferedEvent): boolean {
    return this.events.has('*') || this.events.has(event.method)
  }

  push(event: PageCdpBufferedEvent): void {
    if (this.closed || !this.accepts(event)) return
    if (this.buffer.length >= this.bufferMax) {
      this.buffer.shift()
      this.dropped++
    }
    this.buffer.push(event)
    this.wake()
  }

  async poll(request?: { maxBatch?: number; maxWaitMs?: number }): Promise<PageCdpPollResult> {
    const maxBatch = Math.max(1, Math.min(this.bufferMax, request?.maxBatch ?? 100))
    const maxWaitMs = Math.max(0, Math.min(this.pollMaxWaitMs, request?.maxWaitMs ?? 30_000))

    if (this.buffer.length === 0 && !this.closed && maxWaitMs > 0) {
      if (this.waiter) {
        throw new Error(`Concurrent poll on debugger subscription "${this.subscriptionId}" is not supported`)
      }
      await new Promise<void>((resolve) => {
        const waiter: PollWaiter = { resolve, timer: undefined }
        this.waiter = waiter
        waiter.timer = setTimeout(() => {
          if (this.waiter === waiter) {
            this.waiter = null
            resolve()
          }
        }, maxWaitMs)
      })
    }

    const events = this.buffer.splice(0, maxBatch)
    const dropped = this.dropped
    this.dropped = 0
    return {
      events,
      dropped,
      closed: this.closed && this.buffer.length === 0,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.wake()
  }

  get isClosed(): boolean {
    return this.closed
  }

  get isDrained(): boolean {
    return this.closed && this.buffer.length === 0
  }

  private wake(): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve()
  }
}

export class PageCdpSubscriptionManager {
  private readonly options: PageCdpSubscriptionManagerOptions
  private readonly subscriptions = new Map<string, PageCdpEventBuffer>()
  private readonly subscriptionsByPage = new Map<string, Set<string>>()

  constructor(options: PageCdpSubscriptionManagerOptions = {}) {
    this.options = options
  }

  subscribe(request: SubscribeRequest): PageCdpEventBuffer {
    if (this.subscriptions.has(request.subscriptionId)) {
      throw new Error(`Debugger subscription already exists: "${request.subscriptionId}"`)
    }

    const subscription = new PageCdpEventBuffer(request, this.options)
    this.subscriptions.set(request.subscriptionId, subscription)

    let pageSubscriptions = this.subscriptionsByPage.get(request.pageId)
    if (!pageSubscriptions) {
      pageSubscriptions = new Set()
      this.subscriptionsByPage.set(request.pageId, pageSubscriptions)
    }
    pageSubscriptions.add(request.subscriptionId)

    return subscription
  }

  pushEvent(pageId: string, event: PageCdpBufferedEvent): void {
    const pageSubscriptions = this.subscriptionsByPage.get(pageId)
    if (!pageSubscriptions || pageSubscriptions.size === 0) return
    for (const subscriptionId of pageSubscriptions) {
      const subscription = this.subscriptions.get(subscriptionId)
      subscription?.push(event)
    }
  }

  async poll(
    subscriptionId: string,
    request?: { maxBatch?: number; maxWaitMs?: number },
  ): Promise<PageCdpPollResult> {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) {
      throw new Error(`Unknown debugger subscription "${subscriptionId}"`)
    }

    const result = await subscription.poll(request)
    if (result.closed) {
      this.forget(subscriptionId, subscription.pageId)
    }
    return result
  }

  closeSubscription(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return
    void subscription.close()
    this.forget(subscriptionId, subscription.pageId)
  }

  closePage(pageId: string): void {
    const pageSubscriptions = this.subscriptionsByPage.get(pageId)
    if (!pageSubscriptions) return
    for (const subscriptionId of pageSubscriptions) {
      const subscription = this.subscriptions.get(subscriptionId)
      if (subscription) void subscription.close()
    }
    this.subscriptionsByPage.delete(pageId)
  }

  clear(): void {
    for (const subscription of this.subscriptions.values()) {
      void subscription.close()
    }
    this.subscriptions.clear()
    this.subscriptionsByPage.clear()
  }

  private forget(subscriptionId: string, pageId: string): void {
    this.subscriptions.delete(subscriptionId)
    this.removeFromPageIndex(subscriptionId, pageId)
  }

  private removeFromPageIndex(subscriptionId: string, pageId: string): void {
    const pageSubscriptions = this.subscriptionsByPage.get(pageId)
    if (!pageSubscriptions) return
    pageSubscriptions.delete(subscriptionId)
    if (pageSubscriptions.size === 0) {
      this.subscriptionsByPage.delete(pageId)
    }
  }
}
