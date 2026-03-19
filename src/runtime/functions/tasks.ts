import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerTasks(registry: FunctionRegistry, deps: { getTaskRunner: () => TaskRunner }): void {
  const { getTaskRunner } = deps

  registry.register('startTask', async (params) => {
    const request = params as WorkerHostMethodMap['startTask']['params']
    if (!request || typeof request.taskId !== 'number') {
      throw new Error('startTask requires a taskId number')
    }
    const taskRunner = getTaskRunner()
    const runId = await taskRunner.startTask(request.taskId, request.input, { type: 'agent' })
    return { runId }
  })

  registry.register('stopTask', async (params) => {
    const request = params as WorkerHostMethodMap['stopTask']['params']
    if (!request || typeof request.runId !== 'string' || request.runId.trim().length === 0) {
      throw new Error('stopTask requires a non-empty runId string')
    }
    const taskRunner = getTaskRunner()
    taskRunner.stopTask(request.runId)
    return undefined
  })
}
