import { bus } from './event-bus.js'

export function initBusBridge(): void {
  const ipc = window.ipc
  if (!ipc) return

  // Forward publish from views → bus
  ipc.bus.onForwardPublish((detail) => {
    bus.publish(detail.topic, detail.data)
  })

  // Forward waitFor from views → bus
  ipc.bus.onForwardWaitFor(async (detail) => {
    try {
      const data = await bus.waitFor(detail.topic, detail.timeoutMs)
      ipc.bus.waitForResolved(detail.waiterId, data)
    } catch {
      ipc.bus.waitForResolved(detail.waiterId, undefined)
    }
  })

  // Forward subscribe from main → bus
  const busSubscriptions = new Map<string, () => void>()

  ipc.bus.onForwardSubscribe((detail) => {
    const unsub = bus.subscribe(detail.topic, (data) => {
      ipc.bus.subscribeEvent(detail.subId, data)
    })
    busSubscriptions.set(detail.subId, unsub)
  })

  ipc.bus.onForwardUnsubscribe((detail) => {
    const unsub = busSubscriptions.get(detail.subId)
    if (unsub) {
      unsub()
      busSubscriptions.delete(detail.subId)
    }
  })
}
