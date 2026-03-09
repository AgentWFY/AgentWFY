import { TlApp } from './components/app'
import { TlTabs } from './components/tabs'
import { TlTabView } from './components/tab_view'
import { TlAgentChat } from './components/agent_chat'
import { TlAgentSettings } from './components/agent_settings'
import { TlJson } from './components/json_view'
import { TlStatusLine } from './components/status_line'
import { TlSelect } from './components/select'
import { TlTaskPanel } from './components/task_panel'
import { initBusBridge } from './bus-bridge'
import { initSessionManager } from './agent/session_manager'
import { loadAuthConfig, hasValidAuth } from './agent/agent_auth'
import { initTaskRunner } from './tasks/task_runner'

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
