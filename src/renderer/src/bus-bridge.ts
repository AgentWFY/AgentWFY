import { bus } from './event-bus'
import { spawnAgent } from './agent/spawn-agent'

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
      const result = await spawnAgent(detail.prompt)
      tools.agentSpawnAgentResult(detail.waiterId, result)
    } catch (err) {
      tools.agentSpawnAgentResult(detail.waiterId, { error: String(err) })
    }
  })
}
