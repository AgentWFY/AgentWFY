// Mobile renderer entry. Defines custom elements, installs the
// agentview:// bridge, wires up the two services, loads the agent
// registry, kicks off the first-agent connect, and mounts <awfy-app>.

import { installAgentViewBridge } from './agent-view-bridge.js'
import { agentRegistry } from './services/agent-registry.js'
import { backendSession } from './services/backend-session.js'
import { dispatch } from './events.js'
import { TlAddAgentScreen } from './components/add_agent_screen.js'
import { TlAgentChat } from './components/agent_chat.js'
import { TlAgentSidebar } from './components/agent_sidebar.js'
import { TlApp } from './components/app.js'
import { TlBanner } from './components/banner.js'
import { TlBottomTabs } from './components/bottom_tabs.js'
import { TlChatInput } from './components/chat_input.js'
import { TlDraftCompose } from './components/draft_compose.js'
import { TlLiveStatus } from './components/live_status.js'
import { TlMainHeader } from './components/main_header.js'
import { TlProviderGrid } from './components/provider_grid.js'
import { TlSessionList } from './components/session_list.js'
import { TlTaskList } from './components/task_list.js'
import { TlViewFrame } from './components/view_frame.js'
import { TlViewList } from './components/view_list.js'

function defineElement(tagName: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tagName)) customElements.define(tagName, ctor)
}

async function init() {
  defineElement('awfy-add-agent-screen', TlAddAgentScreen)
  defineElement('awfy-agent-chat', TlAgentChat)
  defineElement('awfy-agent-sidebar', TlAgentSidebar)
  defineElement('awfy-banner', TlBanner)
  defineElement('awfy-bottom-tabs', TlBottomTabs)
  defineElement('awfy-chat-input', TlChatInput)
  defineElement('awfy-draft-compose', TlDraftCompose)
  defineElement('awfy-live-status', TlLiveStatus)
  defineElement('awfy-main-header', TlMainHeader)
  defineElement('awfy-provider-grid', TlProviderGrid)
  defineElement('awfy-session-list', TlSessionList)
  defineElement('awfy-task-list', TlTaskList)
  defineElement('awfy-view-frame', TlViewFrame)
  defineElement('awfy-view-list', TlViewList)
  defineElement('awfy-app', TlApp)

  installAgentViewBridge()
  backendSession.install()

  const root = document.querySelector<HTMLElement>('#app')
  if (root) root.appendChild(document.createElement('awfy-app'))

  // Bootstrap: load registry, then either drop into add-agent (no agents
  // yet) or connect to the first one. Mirrors desktop's "first persisted
  // agent is selected by default" flow.
  const agents = await agentRegistry.refresh()
  if (agents.length === 0) {
    dispatch('set-screen', { screen: 'add-agent' })
  } else {
    dispatch('switch-agent', { agentId: agents[0].agentId })
  }
}

init().catch((err) => {
  console.error('[mobile] init failed:', err)
})
