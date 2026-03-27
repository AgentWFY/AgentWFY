import { TlApp } from './components/app.js'
import { TlTabs } from './components/tabs.js'
import { TlTabView } from './components/tab_view.js'
import { TlAgentChat } from './components/agent_chat.js'
import { TlAgentSettings } from './components/agent_settings.js'
import { TlStatusLine } from './components/status_line.js'
import { TlSelect } from './components/select.js'
import { TlTaskPanel } from './components/task_panel.js'
import { TlAgentSidebar } from './components/agent_sidebar.js'
import { initBusBridge } from './bus-bridge.js'
import { agentSessionStore } from './stores/agent-session-store.js'

function defineElement(tagName: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ctor)
  }
}

async function init() {
  defineElement('awfy-agent-settings', TlAgentSettings)
  defineElement('awfy-tab-view', TlTabView)
  defineElement('awfy-tabs', TlTabs)
  defineElement('awfy-agent-chat', TlAgentChat)
  defineElement('awfy-status-line', TlStatusLine)
  defineElement('awfy-select', TlSelect)
  defineElement('awfy-task-panel', TlTaskPanel)
  defineElement('awfy-agent-sidebar', TlAgentSidebar)
  defineElement('awfy-app', TlApp)

  initBusBridge()
  agentSessionStore.init()

  document.body.appendChild(document.createElement('awfy-app'))
}

export default init()
