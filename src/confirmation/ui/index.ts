import type { ConfirmationScreen, ConfirmationScreenFactory } from './screen.js'
import { pluginInstallScreen, pluginToggleScreen, pluginUninstallScreen } from './screens/plugin.js'
import { agentInstallScreen } from './screens/agent.js'

declare global {
  interface Window {
    confirmationBridge: {
      onShow(callback: (request: { screen: string; params: Record<string, unknown>; requestId: string }) => void): () => void
      sendResult(requestId: string, confirmed: boolean, data?: Record<string, unknown>): Promise<void>
      pickDirectory(): Promise<string | null>
    }
  }
}

const screenRegistry: Record<string, ConfirmationScreenFactory> = {
  'confirm-plugin-install': pluginInstallScreen,
  'confirm-plugin-toggle': pluginToggleScreen,
  'confirm-plugin-uninstall': pluginUninstallScreen,
  'confirm-agent-install': agentInstallScreen,
}

function init(): void {
  const bridge = window.confirmationBridge
  const titleEl = document.getElementById('title')!
  const bodyEl = document.getElementById('body')!
  const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement
  const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement

  let currentRequestId: string | null = null
  let currentScreen: ConfirmationScreen | null = null

  function show(request: { screen: string; params: Record<string, unknown>; requestId: string }): void {
    const factory = screenRegistry[request.screen]
    if (!factory) {
      void bridge.sendResult(request.requestId, false)
      return
    }

    const screen = factory(request.params)
    currentRequestId = request.requestId
    currentScreen = screen

    titleEl.textContent = screen.title
    bodyEl.innerHTML = ''
    screen.renderBody(bodyEl)
    confirmBtn.textContent = screen.confirmLabel
    cancelBtn.textContent = screen.cancelLabel || 'Cancel'
  }

  function respond(confirmed: boolean): void {
    if (!currentRequestId) return
    let data: Record<string, unknown> | undefined
    if (confirmed && currentScreen?.getData) {
      const result = currentScreen.getData()
      if (result === null) return // not ready, block confirmation
      data = result
    }
    const id = currentRequestId
    currentRequestId = null
    currentScreen = null
    void bridge.sendResult(id, confirmed, data)
  }

  confirmBtn.addEventListener('click', () => respond(true))
  cancelBtn.addEventListener('click', () => respond(false))

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      respond(false)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      respond(true)
    }
  })

  bridge.onShow(show)
}

init()
