import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerAgent(registry: FunctionRegistry, deps: { getSessionManager: () => AgentSessionManager }): void {
  const { getSessionManager } = deps

  registry.register('spawnAgent', async (params) => {
    const request = params as WorkerHostMethodMap['spawnAgent']['params']
    if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new Error('spawnAgent requires a non-empty prompt string')
    }
    const sessionManager = getSessionManager()
    return sessionManager.spawnSession(request.prompt)
  })

  registry.register('sendToAgent', async (params) => {
    const request = params as WorkerHostMethodMap['sendToAgent']['params']
    if (!request || typeof request.agentId !== 'string' || request.agentId.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty agentId string')
    }
    if (typeof request.message !== 'string' || request.message.trim().length === 0) {
      throw new Error('sendToAgent requires a non-empty message string')
    }
    const sessionManager = getSessionManager()
    await sessionManager.sendToAgent(request.agentId, request.message)
    return undefined
  })
}
