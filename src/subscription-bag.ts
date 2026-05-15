export type Disposer = () => void

export class SubscriptionBag {
  private readonly disposers = new Set<Disposer>()

  add(disposer: Disposer): Disposer {
    this.disposers.add(disposer)
    return () => {
      this.disposers.delete(disposer)
      disposer()
    }
  }

  dispose(): void {
    const disposers = Array.from(this.disposers)
    this.disposers.clear()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (err) {
        console.warn('[subscription-bag] disposer failed:', err)
      }
    }
  }
}
