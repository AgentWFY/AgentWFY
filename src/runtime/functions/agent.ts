import type { WebContents } from 'electron'
import type { AgentSessionManager } from '../../agent/session_manager.js'
import type { FunctionRegistry } from '../function_registry.js'
import type { WorkerHostMethodMap } from '../types.js'

export function registerAgent(registry: FunctionRegistry, deps: { getSessionManager: () => AgentSessionManager; rendererWebContents: WebContents }): void {
  const { getSessionManager, rendererWebContents: rwc } = deps

  registry.register('spawnSession', async (params) => {
    const request = params as WorkerHostMethodMap['spawnSession']['params']
    if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new Error('spawnSession requires a non-empty prompt string')
    }
    const sessionManager = getSessionManager()
    return sessionManager.spawnSession(request.prompt)
  })

  registry.register('sendToSession', async (params) => {
    const request = params as WorkerHostMethodMap['sendToSession']['params']
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty sessionId string')
    }
    if (typeof request.message !== 'string' || request.message.trim().length === 0) {
      throw new Error('sendToSession requires a non-empty message string')
    }
    const sessionManager = getSessionManager()
    await sessionManager.sendToSession(request.sessionId, request.message)
    return undefined
  })

  registry.register('openSessionInChat', async (params) => {
    const request = params as WorkerHostMethodMap['openSessionInChat']['params']
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.trim().length === 0) {
      throw new Error('openSessionInChat requires a non-empty sessionId string')
    }
    const sessionManager = getSessionManager()
    const { label } = await sessionManager.openSessionInChat(request.sessionId)

    // Notify the renderer to add this session to the open sessions list and show the chat panel
    if (!rwc.isDestroyed()) {
      const detail = JSON.stringify({ file: request.sessionId, label }).replace(/</g, '\\u003c')
      rwc.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('agentwfy:open-session-in-chat', { detail: ${detail} }));`,
        true,
      ).catch((err) => { console.warn('[agent-functions] executeJavaScript failed:', err) })
    }
  })
}
