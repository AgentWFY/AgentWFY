import { bus } from './event-bus'
import { getSessionManager } from './agent/session_manager'

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

  // Forward spawnAgent from views → session manager
  ipc.bus.onForwardSpawnAgent(async (detail) => {
    try {
      const mgr = getSessionManager()
      if (!mgr) throw new Error('AgentSessionManager not initialized')
      const result = await mgr.spawnSession(detail.prompt)
      ipc.bus.spawnAgentResult(detail.waiterId, result)
    } catch (err) {
      ipc.bus.spawnAgentResult(detail.waiterId, { error: String(err) })
    }
  })
}
