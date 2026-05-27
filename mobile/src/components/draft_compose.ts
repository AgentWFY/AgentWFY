// Draft compose body: provider grid + composer + live status. Mounted
// after the user taps "New session" but before they've sent anything; the
// first sendMessage spawns the session under the selected provider and
// connected_pane swaps this for awfy-agent-chat.

export class TlDraftCompose extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <awfy-provider-grid></awfy-provider-grid>
      <awfy-chat-input mode="draft"></awfy-chat-input>
      <awfy-live-status></awfy-live-status>
    `
  }
}
