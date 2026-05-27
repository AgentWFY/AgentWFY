// Composer: textarea + send + abort. Used by both the active-session chat
// (with session-id attribute) and the draft compose screen (with
// provider-id attribute). Parent picks the mode via which attribute it
// sets.
//
// The composer listens to status-changed, providers-changed and
// session-state to compute its own disabled / abort state. It doesn't
// re-render its DOM on those events — it just toggles button state, so
// the textarea content survives.

import { backendSession } from '../services/backend-session.js'
import { dispatch, listen } from '../events.js'
import type { BackendStatusSnapshot, ProviderState } from '#shared/backend/interface.js'
import type { RetryState } from '#shared/agent/types.js'
import { ICON_SEND } from './icons.js'
import { autoSizeTextarea } from './util.js'

export class TlChatInput extends HTMLElement {
  static get observedAttributes() { return ['session-id', 'provider-id'] }

  private formEl!: HTMLFormElement
  private textareaEl!: HTMLTextAreaElement
  private errorEl!: HTMLParagraphElement
  private submitBtn!: HTMLButtonElement
  private abortBtn!: HTMLButtonElement
  private hintEl!: HTMLSpanElement
  private sending = false
  private status: BackendStatusSnapshot = backendSession.getStatus()
  private providers: ProviderState | null = backendSession.getProviders()
  private live: { isStreaming?: boolean; retryState?: RetryState | null } | null = null
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.innerHTML = `
      <form class="composer chat-composer" novalidate>
        <div class="composer-field">
          <textarea name="prompt" rows="1" autocapitalize="sentences" required></textarea>
          <button type="submit" class="composer-send" aria-label="Send" title="Send">${ICON_SEND}</button>
        </div>
        <div class="composer-meta">
          <span class="composer-hint" hidden></span>
          <button type="button" class="composer-abort" hidden>Abort</button>
        </div>
        <p class="field-error composer-error hidden"></p>
      </form>
    `
    this.formEl = this.querySelector<HTMLFormElement>('.chat-composer')!
    this.textareaEl = this.formEl.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')!
    this.errorEl = this.formEl.querySelector<HTMLParagraphElement>('.composer-error')!
    this.submitBtn = this.formEl.querySelector<HTMLButtonElement>('.composer-send')!
    this.abortBtn = this.formEl.querySelector<HTMLButtonElement>('.composer-abort')!
    this.hintEl = this.formEl.querySelector<HTMLSpanElement>('.composer-hint')!
    this.applyPlaceholder()

    this.textareaEl.addEventListener('input', () => {
      autoSizeTextarea(this.textareaEl)
      this.errorEl.classList.add('hidden')
    })
    this.formEl.addEventListener('submit', (evt) => {
      evt.preventDefault()
      void this.submit()
    })
    this.abortBtn.addEventListener('click', () => {
      const sid = this.getAttribute('session-id')
      if (!sid || this.abortBtn.disabled) return
      this.abortBtn.disabled = true
      dispatch('abort-session', { sessionId: sid })
      // Re-enable on the next live event; if none arrives quickly, this
      // stays disabled until the user reloads — that's preferable to
      // racing the abort with a duplicate click.
    })

    autoSizeTextarea(this.textareaEl)

    this.unsubs.push(
      listen('status-changed', ({ status }) => { this.status = status; this.applyEnabled() }),
      listen('providers-changed', ({ providers }) => { this.providers = providers; this.applyEnabled() }),
      listen('session-state', ({ sessionId, live }) => {
        const myId = this.getAttribute('session-id')
        if (myId && sessionId === myId) {
          this.live = live ?? null
          this.applyEnabled()
        }
      }),
    )

    this.applyEnabled()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
  }

  attributeChangedCallback() {
    if (!this.isConnected) return
    this.live = null
    this.applyPlaceholder()
    this.applyEnabled()
  }

  private applyPlaceholder() {
    if (!this.textareaEl) return
    this.textareaEl.placeholder = this.hasAttribute('provider-id')
      ? 'Ask the agent anything…'
      : 'Send a follow-up…'
  }

  private async submit() {
    if (this.submitBtn.disabled) return
    const prompt = this.textareaEl.value.trim()
    if (!prompt) {
      this.errorEl.classList.remove('hidden')
      this.errorEl.textContent = 'Prompt is required.'
      this.textareaEl.focus()
      return
    }
    this.sending = true
    this.applyEnabled()
    this.errorEl.classList.add('hidden')
    this.textareaEl.value = ''
    autoSizeTextarea(this.textareaEl)

    const sessionId = this.getAttribute('session-id')
    const providerId = this.getAttribute('provider-id')

    let ok = true
    try {
      if (sessionId) {
        ok = await backendSession.sendFollowup(sessionId, { text: prompt })
      } else if (providerId) {
        const newId = await backendSession.sendDraft({ providerId, text: prompt })
        ok = newId !== null
      }
    } catch {
      ok = false
    }

    if (!ok && this.isConnected && this.textareaEl.value.length === 0) {
      // RPC failed (an error event has already been dispatched). Restore
      // the draft so the user can retry; only if they haven't started a
      // new draft in the meantime.
      this.textareaEl.value = prompt
      autoSizeTextarea(this.textareaEl)
    }
    this.sending = false
    if (this.isConnected) this.applyEnabled()
  }

  private applyEnabled() {
    const reason = this.disabledReason()
    const canSend = reason === null
    this.textareaEl.disabled = !canSend
    this.submitBtn.disabled = !canSend || this.sending
    this.hintEl.hidden = reason === null
    this.hintEl.textContent = reason ?? ''
    const hasLive = !!(this.live?.isStreaming || this.live?.retryState)
    this.abortBtn.hidden = !hasLive
    this.abortBtn.disabled = !(this.status.state === 'connected' && this.getAttribute('session-id') && hasLive)
  }

  private disabledReason(): string | null {
    if (this.status.state !== 'connected') {
      return this.status.message || 'Remote agent is disconnected.'
    }
    const isDraft = !!this.getAttribute('provider-id')
    if (isDraft && !this.providers) return 'Loading providers…'
    if (isDraft && this.providers?.providerList.length === 0) {
      return 'No providers are configured on this daemon.'
    }
    return null
  }
}
