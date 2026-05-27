// Composer: textarea + send + abort. Used by both the active-session chat
// (follow-up mode) and the draft-compose screen (draft mode). Matches
// desktop's awfy-chat-input role.
//
// Subscribes to controller for enabled/disabled state. Does NOT re-render
// its inner DOM on state changes — the textarea must keep its draft text
// across patches.

import { controller } from '../controller.js'
import type { AppState } from '../app-state.js'
import { ICON_SEND } from './icons.js'
import { autoSizeTextarea } from './util.js'

export type ChatInputMode = 'draft' | 'followup'

export class TlChatInput extends HTMLElement {
  private formEl!: HTMLFormElement
  private textareaEl!: HTMLTextAreaElement
  private errorEl!: HTMLParagraphElement
  private submitBtn!: HTMLButtonElement
  private abortBtn!: HTMLButtonElement
  private hintEl!: HTMLSpanElement
  private sending = false
  private unsubscribe: (() => void) | null = null

  static get observedAttributes() { return ['mode'] }

  get mode(): ChatInputMode {
    const v = this.getAttribute('mode')
    return v === 'draft' ? 'draft' : 'followup'
  }

  connectedCallback() {
    const placeholder = this.mode === 'draft' ? 'Ask the agent anything…' : 'Send a follow-up…'
    this.innerHTML = `
      <form class="composer chat-composer" data-mode="${this.mode}" novalidate>
        <div class="composer-field">
          <textarea name="prompt" rows="1" autocapitalize="sentences" required placeholder="${placeholder}"></textarea>
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

    this.textareaEl.addEventListener('input', () => {
      autoSizeTextarea(this.textareaEl)
      this.errorEl.classList.add('hidden')
    })
    this.formEl.addEventListener('submit', (evt) => {
      evt.preventDefault()
      void this.submit()
    })
    this.abortBtn.addEventListener('click', () => {
      if (this.abortBtn.disabled) return
      this.abortBtn.disabled = true
      void controller.abortActiveSession().finally(() => {
        if (this.isConnected) this.abortBtn.disabled = false
      })
    })

    autoSizeTextarea(this.textareaEl)
    this.unsubscribe = controller.subscribe((state) => this.patch(state))
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
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
    this.submitBtn.disabled = true
    this.errorEl.classList.add('hidden')
    this.textareaEl.value = ''
    autoSizeTextarea(this.textareaEl)
    try {
      const sessionId = await controller.sendMessage({ text: prompt })
      if (!sessionId && this.isConnected) {
        // Send failed — restore the draft so the user can retry.
        this.textareaEl.value = prompt
        autoSizeTextarea(this.textareaEl)
      }
    } finally {
      this.sending = false
      if (this.isConnected) this.patch(controller.getState())
    }
  }

  private patch(state: AppState) {
    const reason = disabledReason(state)
    const canSend = reason === null
    this.textareaEl.disabled = !canSend
    this.submitBtn.disabled = !canSend || this.sending
    this.hintEl.hidden = reason === null
    this.hintEl.textContent = reason ?? ''
    const abortable = canAbort(state)
    this.abortBtn.hidden = !hasLiveWork(state)
    this.abortBtn.disabled = !abortable
  }
}

function disabledReason(state: AppState): string | null {
  if (state.status.state !== 'connected') {
    return state.status.message || 'Remote agent is disconnected.'
  }
  if (!state.activeSession && !state.providers) return 'Loading providers…'
  if (!state.activeSession && state.providers?.providerList.length === 0) {
    return 'No providers are configured on this daemon.'
  }
  return null
}

function hasLiveWork(state: AppState): boolean {
  const live = state.activeSession?.live
  return !!(live?.isStreaming || live?.retryState)
}

function canAbort(state: AppState): boolean {
  return state.status.state === 'connected' && !!state.activeSession && hasLiveWork(state)
}
