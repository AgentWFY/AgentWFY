import type { TaskRunner } from '../../task-runner/task_runner.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

const DOCS_HINT = 'Read `@docs/system.tasks` for the full function reference.'

export function registerTasks(registry: FunctionRegistry, deps: { getTaskRunner: () => TaskRunner }): void {
  const { getTaskRunner } = deps

  registry.register('startTask', async (params) => {
    const request = params as WorkerHostMethodMap['startTask']['params']
    if (!request || typeof request.taskName !== 'string' || !request.taskName.trim()) {
      throw new Error(`startTask requires a taskName string. ${DOCS_HINT}`)
    }
    const taskRunner = getTaskRunner()
    const runId = await taskRunner.startTask(request.taskName, request.input, { type: 'agent' })
    return { runId }
  })

  registry.register('stopTask', async (params) => {
    const request = params as WorkerHostMethodMap['stopTask']['params']
    if (!request || typeof request.runId !== 'string' || request.runId.trim().length === 0) {
      throw new Error(`stopTask requires a non-empty runId string. ${DOCS_HINT}`)
    }
    const taskRunner = getTaskRunner()
    taskRunner.stopTask(request.runId)
    return undefined
  })

  registry.register('listTaskRuns', async (params) => {
    const request = (params ?? {}) as WorkerHostMethodMap['listTaskRuns']['params']
    return getTaskRunner().listTaskRuns(request)
  })

  registry.register('searchTaskRuns', async (params) => {
    const request = params as WorkerHostMethodMap['searchTaskRuns']['params']
    if (!request || typeof request.pattern !== 'string' || request.pattern.length === 0) {
      throw new Error(`searchTaskRuns requires a non-empty pattern string. ${DOCS_HINT}`)
    }
    return getTaskRunner().searchTaskRuns(request)
  })

  registry.register('readTaskRun', async (params) => {
    const request = params as WorkerHostMethodMap['readTaskRun']['params']
    if (!request || typeof request.runId !== 'string' || request.runId.trim().length === 0) {
      throw new Error(`readTaskRun requires a non-empty runId string. ${DOCS_HINT}`)
    }
    return getTaskRunner().readTaskRun(request.runId)
  })
}
