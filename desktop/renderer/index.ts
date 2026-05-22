import { TlApp } from './components/app.js'
import { TlTabs } from './components/tabs.js'
import { TlTabView } from './components/tab_view.js'
import { TlAgentChat } from './components/agent_chat.js'
import { TlChatInput } from './components/chat_input.js'
import { TlProviderGrid } from './components/provider_grid.js'
import { TlSessionTabs } from './components/session_tabs.js'
import { TlStatusLine } from './components/status_line.js'
import { TlSelect } from './components/select.js'
import { TlTaskPanel } from './components/task_panel.js'
import { TlAgentSidebar } from './components/agent_sidebar.js'
import { TlTracePanel } from './components/trace_panel.js'
import { agentSessionStore } from './stores/agent-session-store.js'

function defineElement(tagName: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ctor)
  }
}

async function init() {
  defineElement('awfy-tab-view', TlTabView)
  defineElement('awfy-tabs', TlTabs)
  defineElement('awfy-chat-input', TlChatInput)
  defineElement('awfy-provider-grid', TlProviderGrid)
  defineElement('awfy-session-tabs', TlSessionTabs)
  defineElement('awfy-agent-chat', TlAgentChat)
  defineElement('awfy-status-line', TlStatusLine)
  defineElement('awfy-select', TlSelect)
  defineElement('awfy-task-panel', TlTaskPanel)
  defineElement('awfy-agent-sidebar', TlAgentSidebar)
  defineElement('awfy-trace-panel', TlTracePanel)
  defineElement('awfy-app', TlApp)

  agentSessionStore.init()

  document.body.appendChild(document.createElement('awfy-app'))
}

export default init()
