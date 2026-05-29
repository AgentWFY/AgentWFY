// Full-screen "connect to a daemon" form. Shown on first launch and when
// the user taps + on the agent sidebar. Mobile-only — desktop adds remote
// agents via the command palette.
//
// Re-renders the cancel buttons when the installed-agents count crosses
// zero (no Cancel when there's nothing to fall back to).

import { agentRegistry } from '../services/agent-registry.js'
import { backendSession } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import { ICON_PLUG, ICON_X } from './icons.js'

export class TlAddAgentScreen extends HTMLElement {
  private formEl!: HTMLFormElement
  private errorEl!: HTMLParagraphElement
  private submitBtn!: HTMLButtonElement
  private cancelXBtn: HTMLButtonElement | null = null
  private cancelBtn: HTMLButtonElement | null = null
  private latestAgentsCount = 0
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.latestAgentsCount = agentRegistry.getAgents().length
    this.render(this.latestAgentsCount > 0)
    this.unsubs.push(
      listen('agents-changed', ({ agents }) => {
        if (agents.length !== this.latestAgentsCount) {
          this.latestAgentsCount = agents.length
          this.render(agents.length > 0)
        }
      }),
    )
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  private render(cancellable: boolean) {
    this.innerHTML = `
      <header class="main-header">
        <div class="main-header-title">
          <h1>Add remote agent</h1>
          <span class="main-header-sub">Connect to a daemon</span>
        </div>
        <div class="main-header-actions">
          ${cancellable ? `<button type="button" class="icon-btn" data-role="cancel-x" aria-label="Cancel" title="Cancel">${ICON_X}</button>` : ''}
        </div>
      </header>
      <awfy-banner></awfy-banner>
      <div class="body">
        <div class="form-pane">
          <form class="form" data-role="form" novalidate>
            <div class="field">
              <label class="field-label" for="add-agent-id">Local label</label>
              <input id="add-agent-id" name="agentId" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="my-daemon" required />
              <span class="field-help">Used locally only — anything unique.</span>
            </div>
            <div class="field">
              <label class="field-label" for="add-base-url">Server URL</label>
              <input id="add-base-url" name="baseUrl" autocomplete="off" autocapitalize="none" autocorrect="off" inputmode="url" value="http://127.0.0.1:9878" required />
            </div>
            <div class="field">
              <label class="field-label" for="add-token">Bearer token</label>
              <input id="add-token" name="agentToken" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" required />
            </div>
            <p class="field-error hidden" data-role="error"></p>
            <div class="form-actions">
              <button type="submit" class="btn primary">${ICON_PLUG}<span>Connect</span></button>
              ${cancellable ? `<button type="button" class="btn ghost" data-role="cancel">Cancel</button>` : ''}
            </div>
          </form>
        </div>
      </div>
    `

    this.formEl = this.querySelector<HTMLFormElement>('[data-role="form"]')!
    this.errorEl = this.querySelector<HTMLParagraphElement>('[data-role="error"]')!
    this.submitBtn = this.formEl.querySelector<HTMLButtonElement>('button[type="submit"]')!
    this.cancelXBtn = this.querySelector<HTMLButtonElement>('[data-role="cancel-x"]')
    this.cancelBtn = this.querySelector<HTMLButtonElement>('[data-role="cancel"]')

    this.formEl.addEventListener('submit', (evt) => {
      evt.preventDefault()
      void this.submit()
    })
    this.cancelXBtn?.addEventListener('click', () => this.cancel())
    this.cancelBtn?.addEventListener('click', () => this.cancel())
  }

  private async submit() {
    if (this.submitBtn.disabled) return
    this.submitBtn.disabled = true
    this.errorEl.classList.add('hidden')
    const data = new FormData(this.formEl)
    try {
      const agentId = await agentRegistry.add({
        agentId: String(data.get('agentId') ?? ''),
        baseUrl: String(data.get('baseUrl') ?? ''),
        agentToken: String(data.get('agentToken') ?? ''),
      })
      // The registry already persisted this agent. Switch directly so the
      // backend session connects with the saved metadata.
      dispatch('switch-agent', { agentId })
    } catch (err) {
      this.submitBtn.disabled = false
      this.errorEl.classList.remove('hidden')
      this.errorEl.textContent = err instanceof Error ? err.message : String(err)
    }
  }

  private cancel() {
    if (backendSession.getActiveAgentId()) {
      dispatch('set-screen', { screen: 'chat' })
      return
    }
    const fallback = agentRegistry.getAgents()[0]
    if (fallback) dispatch('switch-agent', { agentId: fallback.agentId })
  }
}
