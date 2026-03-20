export interface BusApi {
  // Agent tool operations
  publish(topic: string, data: unknown): Promise<void>
  waitFor(topic: string, timeoutMs?: number): Promise<unknown>
  // Bridge/events (app only)
  onForwardPublish(callback: (detail: { topic: string; data: unknown }) => void): () => void
  onForwardWaitFor(callback: (detail: { waiterId: string; topic: string; timeoutMs?: number }) => void): () => void
  waitForResolved(waiterId: string, data: unknown): void
  onForwardSubscribe(callback: (detail: { subId: string; topic: string }) => void): () => void
  onForwardUnsubscribe(callback: (detail: { subId: string }) => void): () => void
  subscribeEvent(subId: string, data: unknown): void
}
