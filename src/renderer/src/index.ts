import "@spectrum-web-components/bundle/elements.js"
import { TlApp } from 'app/components/app'
import { TlTabs } from 'app/components/tabs'
import { TlExternalView } from 'app/components/external_view'
import { TlAgentChat } from 'app/components/agent_chat'
import { TlAgentSettings } from 'app/components/agent_settings'
import { TlSqlModal } from 'app/components/sql_confirmation_modal'
import { TlJson } from 'app/components/json_view'

function defineElement(tagName: string, ctor: CustomElementConstructor) {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, ctor)
  }
}

async function init() {
  defineElement('tl-json', TlJson)
  defineElement('tl-agent-settings', TlAgentSettings)
  defineElement('tl-sql-modal', TlSqlModal)
  defineElement('tl-external-view', TlExternalView)
  defineElement('tl-tabs', TlTabs)
  defineElement('tl-agent-chat', TlAgentChat)
  defineElement('tl-app', TlApp)

  document.body.appendChild(document.createElement('tl-app'))
}

export default init()
