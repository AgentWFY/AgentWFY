import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'
import type { RendererPush } from '../hosts.js'

const DOCS_HINT = 'Read `@docs/system.sessions` for the full function reference.'

export function registerAgent(
  registry: FunctionRegistry,
  deps: {
    getSessionManager: () => AgentSessionManager
    /** Optional — when absent, openSessionInChat does the data work only and skips the UI nudge. */
    rendererPush?: RendererPush
  },
): void {
  const { getSessionManager, rendererPush } = deps

  registry.register('spawnSession', async (params) => {
    const request = params as WorkerHostMethodMap['spawnSession']['params']
    if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new Error(`spawnSession requires a non-empty prompt string. ${DOCS_HINT}`)
    }
    const sessionManager = getSessionManager()
    return sessionManager.spawnSession(request.prompt, request.providerId, request.providerOptions)
  })

  registry.register('sendToSession', async (params) => {
    const request = params as WorkerHostMethodMap['sendToSession']['params']
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      throw new Error(`sendToSession requires a non-empty sessionId string. ${DOCS_HINT}`)
    }
    if (typeof request.message !== 'string' || request.message.trim().length === 0) {
      throw new Error(`sendToSession requires a non-empty message string. ${DOCS_HINT}`)
    }
    const sessionManager = getSessionManager()
    await sessionManager.sendToSession(request.sessionId, request.message)
    return undefined
  })

  registry.register('openSessionInChat', async (params) => {
    const request = params as WorkerHostMethodMap['openSessionInChat']['params']
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      throw new Error(`openSessionInChat requires a non-empty sessionId string. ${DOCS_HINT}`)
    }
    const sessionManager = getSessionManager()
    const { label } = await sessionManager.openSessionInChat(request.sessionId)

    // The renderer push is best-effort — if no host (e.g. running in the
    // headless daemon), the chat-panel surface simply doesn't exist.
    rendererPush?.openSessionInChat({ sessionId: request.sessionId, label })
  })

  registry.register('listSessions', async (params) => {
    const request = (params ?? {}) as WorkerHostMethodMap['listSessions']['params']
    return getSessionManager().listSessions(request)
  })

  registry.register('searchSessions', async (params) => {
    const request = params as WorkerHostMethodMap['searchSessions']['params']
    if (!request || typeof request.pattern !== 'string' || request.pattern.length === 0) {
      throw new Error(`searchSessions requires a non-empty pattern string. ${DOCS_HINT}`)
    }
    return getSessionManager().searchSessions(request)
  })

  registry.register('readSession', async (params) => {
    const request = params as WorkerHostMethodMap['readSession']['params']
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      throw new Error(`readSession requires a non-empty sessionId string. ${DOCS_HINT}`)
    }
    return getSessionManager().readSession(request.sessionId)
  })
}
