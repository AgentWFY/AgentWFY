// Mobile renderer entry. Mirrors desktop/renderer/index.ts: define all
// custom elements, install the agentview:// bridge, kick off the initial
// load, and mount <awfy-app>. From there the controller singleton drives
// state and each custom element subscribes to it independently.

import { installAgentViewBridge } from './agent-view-bridge.js'
import { controller } from './controller.js'
import { TlAddAgentScreen } from './components/add_agent_screen.js'
import { TlAgentChat } from './components/agent_chat.js'
import { TlAgentSidebar } from './components/agent_sidebar.js'
import { TlApp } from './components/app.js'
import { TlBanner } from './components/banner.js'
import { TlBottomTabs } from './components/bottom_tabs.js'
import { TlChatInput } from './components/chat_input.js'
import { TlConnectedPane } from './components/connected_pane.js'
import { TlDraftCompose } from './components/draft_compose.js'
import { TlLiveStatus } from './components/live_status.js'
import { TlMainHeader } from './components/main_header.js'
import { TlProviderGrid } from './components/provider_grid.js'
import { TlSessionList } from './components/session_list.js'
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
  defineElement('awfy-connected-pane', TlConnectedPane)
  defineElement('awfy-draft-compose', TlDraftCompose)
  defineElement('awfy-live-status', TlLiveStatus)
  defineElement('awfy-main-header', TlMainHeader)
  defineElement('awfy-provider-grid', TlProviderGrid)
  defineElement('awfy-session-list', TlSessionList)
  defineElement('awfy-view-frame', TlViewFrame)
  defineElement('awfy-view-list', TlViewList)
  defineElement('awfy-app', TlApp)

  installAgentViewBridge(controller)

  // Load installed agents, then either drop into add-agent (no agents yet)
  // or connect to the first one. Mirrors desktop's "first persisted agent
  // is selected by default" flow.
  await controller.refreshAgents()
  const agents = controller.getState().agents
  if (agents.length === 0) {
    controller.setScreen('add-agent')
  } else {
    void controller.connect(agents[0].agentId)
  }

  const root = document.querySelector<HTMLElement>('#app')
  if (root) root.appendChild(document.createElement('awfy-app'))
}

init().catch((err) => {
  console.error('[mobile] init failed:', err)
})
