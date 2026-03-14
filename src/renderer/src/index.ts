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
  defineElement('awfy-json', TlJson)
  defineElement('awfy-agent-settings', TlAgentSettings)
  defineElement('awfy-tab-view', TlTabView)
  defineElement('awfy-tabs', TlTabs)
  defineElement('awfy-agent-chat', TlAgentChat)
  defineElement('awfy-status-line', TlStatusLine)
  defineElement('awfy-select', TlSelect)
  defineElement('awfy-task-panel', TlTaskPanel)
  defineElement('awfy-app', TlApp)

  const authConfig = await loadAuthConfig()
  if (hasValidAuth(authConfig)) {
    await initSessionManager(authConfig)
  }

  initTaskRunner()
  initBusBridge()

  document.body.appendChild(document.createElement('awfy-app'))
}

export default init()
