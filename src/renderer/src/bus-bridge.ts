import { bus } from './event-bus'
import { getSessionManager } from './agent/session_manager'

export function initBusBridge(): void {
  const tools = window.electronClientTools
  if (!tools) return

  // Forward publish from views → bus
  tools.onBusForwardPublish((detail) => {
    bus.publish(detail.topic, detail.data)
  })

  // Forward waitFor from views → bus
  tools.onBusForwardWaitFor(async (detail) => {
    try {
      const data = await bus.waitFor(detail.topic, detail.timeoutMs)
      tools.busWaitForResolved(detail.waiterId, data)
    } catch {
      tools.busWaitForResolved(detail.waiterId, undefined)
    }
  })

  // Forward spawnAgent from views → session manager
  tools.onAgentForwardSpawnAgent(async (detail) => {
    try {
      const mgr = getSessionManager()
      if (!mgr) throw new Error('AgentSessionManager not initialized')
      const result = await mgr.spawnSession(detail.prompt)
      tools.agentSpawnAgentResult(detail.waiterId, result)
    } catch (err) {
      tools.agentSpawnAgentResult(detail.waiterId, { error: String(err) })
    }
  })
}
