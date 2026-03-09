import { TlApp } from './components/app.js'
import { TlTabs } from './components/tabs.js'
import { TlTabView } from './components/tab_view.js'
import { TlAgentChat } from './components/agent_chat.js'
import { TlAgentSettings } from './components/agent_settings.js'
import { TlJson } from './components/json_view.js'
import { TlStatusLine } from './components/status_line.js'
import { TlSelect } from './components/select.js'
import { TlTaskPanel } from './components/task_panel.js'
import { initBusBridge } from './bus-bridge.js'
import { initSessionManager } from './agent/session_manager.js'
import { loadAuthConfig, hasValidAuth } from './agent/agent_auth.js'
import { initTaskRunner } from './tasks/task_runner.js'

function defineElement(tagName: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ctor)
  }
}

async function init() {
  defineElement('tl-json', TlJson)
  defineElement('tl-agent-settings', TlAgentSettings)
  defineElement('tl-tab-view', TlTabView)
  defineElement('tl-tabs', TlTabs)
  defineElement('tl-agent-chat', TlAgentChat)
  defineElement('tl-status-line', TlStatusLine)
  defineElement('tl-select', TlSelect)
  defineElement('tl-task-panel', TlTaskPanel)
  defineElement('tl-app', TlApp)

  const authConfig = await loadAuthConfig()
  if (hasValidAuth(authConfig)) {
    await initSessionManager(authConfig)
  }

  initTaskRunner()
  initBusBridge()

  document.body.appendChild(document.createElement('tl-app'))
}

export default init()
