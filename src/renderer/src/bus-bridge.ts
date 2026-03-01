import { bus } from './event-bus'
import { getSessionManager } from './agent/session_manager'
import { getTaskRunner } from './tasks/task_runner'

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

  // Forward task:invoke from views → task runner
  tools.onTaskForwardInvoke(async (detail) => {
    try {
      const runner = getTaskRunner()
      if (!runner) throw new Error('TaskRunner not initialized')
      let value: unknown
      switch (detail.method) {
        case 'startTask':
          value = { runId: await runner.startTask(detail.params.taskId as number) }
          break
        case 'stopTask':
          runner.stopTask(detail.params.runId as string)
          value = undefined
          break
        default:
          throw new Error(`Unknown task method: ${detail.method}`)
      }
      tools.taskInvokeResult(detail.waiterId, { ok: true, value })
    } catch (err) {
      tools.taskInvokeResult(detail.waiterId, { ok: false, error: String(err) })
    }
  })
}
