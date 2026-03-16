import { bus } from './event-bus.js'
import { getSessionManager } from './agent/session_manager.js'
import { getTaskRunner } from './tasks/task_runner.js'
import type { TaskOrigin } from './tasks/task_runner.js'

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

  // Forward sendToAgent from views → session manager
  ipc.bus.onForwardSendToAgent(async (detail) => {
    try {
      const mgr = getSessionManager()
      if (!mgr) throw new Error('AgentSessionManager not initialized')
      await mgr.sendToAgent(detail.agentId, detail.message)
      ipc.bus.sendToAgentResult(detail.waiterId, {})
    } catch (err) {
      ipc.bus.sendToAgentResult(detail.waiterId, { error: String(err) })
    }
  })

  // Forward startTask from agentview / triggers → task runner
  ipc.tasks.onForwardStartTask(async (detail) => {
    try {
      const runner = getTaskRunner()
      if (!runner) throw new Error('TaskRunner not initialized')
      const origin = (detail.origin as TaskOrigin) ?? { type: 'view' as const }
      const runId = await runner.startTask(detail.taskId, detail.input, origin)
      ipc.tasks.forwardStartTaskResult(detail.waiterId, { runId })
    } catch (err) {
      ipc.tasks.forwardStartTaskResult(detail.waiterId, { error: String(err) })
    }
  })

  // Forward stopTask from agentview → task runner
  ipc.tasks.onForwardStopTask(async (detail) => {
    try {
      const runner = getTaskRunner()
      if (!runner) throw new Error('TaskRunner not initialized')
      runner.stopTask(detail.runId)
      ipc.tasks.forwardStopTaskResult(detail.waiterId, {})
    } catch (err) {
      ipc.tasks.forwardStopTaskResult(detail.waiterId, { error: String(err) })
    }
  })
}
