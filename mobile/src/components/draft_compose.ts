// Draft compose body: provider grid + composer + live status. Receives a
// provider-id attribute from the router-shell; mirrors it onto the
// provider grid (for "selected" highlight) and the chat-input (so it
// knows to send as a draft).

export class TlDraftCompose extends HTMLElement {
  static get observedAttributes() { return ['provider-id'] }

  connectedCallback() {
    this.innerHTML = `
      <awfy-provider-grid></awfy-provider-grid>
      <awfy-chat-input></awfy-chat-input>
      <awfy-live-status></awfy-live-status>
    `
    this.syncChildren()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.syncChildren()
  }

  private syncChildren() {
    const pid = this.getAttribute('provider-id')
    const grid = this.querySelector('awfy-provider-grid')
    const input = this.querySelector('awfy-chat-input')
    const status = this.querySelector('awfy-live-status')
    if (grid) {
      if (pid) grid.setAttribute('selected-id', pid)
      else grid.removeAttribute('selected-id')
    }
    if (input) {
      if (pid) {
        input.setAttribute('provider-id', pid)
        input.removeAttribute('session-id')
      } else {
        input.removeAttribute('provider-id')
      }
    }
    if (status) {
      if (pid) status.setAttribute('draft-provider-id', pid)
      else status.removeAttribute('draft-provider-id')
    }
  }
}
