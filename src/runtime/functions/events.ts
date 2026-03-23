import type { BrowserWindow } from 'electron'
import { forwardBusPublish, forwardBusWaitFor } from '../../ipc/bus.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerEvents(registry: FunctionRegistry, deps: { win: BrowserWindow }): void {
  const { win } = deps

  registry.register('publish', async (params) => {
    const request = params as WorkerHostMethodMap['publish']['params']
    if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
      throw new Error('publish requires a non-empty topic string')
    }
    forwardBusPublish(win, request.topic, request.data)
    return undefined
  })

  registry.register('waitFor', async (params) => {
    const request = params as WorkerHostMethodMap['waitFor']['params']
    if (!request || typeof request.topic !== 'string' || request.topic.trim().length === 0) {
      throw new Error('waitFor requires a non-empty topic string')
    }
    const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
      ? request.timeoutMs
      : 120_000
    return forwardBusWaitFor(win, request.topic, timeoutMs)
  })
}
