/* eslint-disable import/no-unresolved */
import { TlApp } from 'app/components/app'
import { TlTabs } from 'app/components/tabs'
import { TlTabView } from 'app/components/tab_view'
import { TlAgentChat } from 'app/components/agent_chat'
import { TlAgentSettings } from 'app/components/agent_settings'
import { TlJson } from 'app/components/json_view'
import { TlActivityBar } from 'app/components/activity_bar'
import { TlStatusLine } from 'app/components/status_line'
import { TlSelect } from 'app/components/select'
import { initBusBridge } from 'app/bus-bridge'
import { initSessionManager } from 'app/agent/session_manager'
import { loadAuthConfig, hasValidAuth } from 'app/agent/agent_auth'

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
  defineElement('tl-activity-bar', TlActivityBar)
  defineElement('tl-status-line', TlStatusLine)
  defineElement('tl-select', TlSelect)
  defineElement('tl-app', TlApp)

  const authConfig = await loadAuthConfig()
  if (hasValidAuth(authConfig)) {
    await initSessionManager(authConfig)
  }

  initBusBridge()

  document.body.appendChild(document.createElement('tl-app'))
}

export default init()
