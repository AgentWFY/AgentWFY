import type { BrowserWindow } from 'electron'
import { forwardBusPublish, forwardBusWaitFor } from '../../ipc/bus.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerEvents(registry: FunctionRegistry, deps: { win: BrowserWindow }): void {
  const { win } = deps

  registry.register('busPublish', async (params) => {
    const request = params as WorkerHostMethodMap['busPublish']['params']
    if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
      throw new Error('busPublish requires a non-empty topic string')
    }
    forwardBusPublish(win, request.topic, request.data)
    return undefined
  })

  registry.register('busWaitFor', async (params) => {
    const request = params as WorkerHostMethodMap['busWaitFor']['params']
    if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
      throw new Error('busWaitFor requires a non-empty topic string')
    }
    const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
      ? request.timeoutMs
      : 120_000
    return forwardBusWaitFor(win, request.topic, timeoutMs)
  })
}
