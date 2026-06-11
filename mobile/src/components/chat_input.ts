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
import type { FileContent, RetryState } from '#shared/agent/types.js'
import { ICON_IMAGE, ICON_SEND } from './icons.js'
import { autoSizeTextarea, escapeHtml, formatBytes } from './util.js'

type PendingAttachment = FileContent & { name: string; size: number }

export class TlChatInput extends HTMLElement {
  static get observedAttributes() { return ['session-id', 'provider-id'] }

  private formEl!: HTMLFormElement
  private textareaEl!: HTMLTextAreaElement
  private errorEl!: HTMLParagraphElement
  private submitBtn!: HTMLButtonElement
  private attachBtn!: HTMLButtonElement
  private abortBtn!: HTMLButtonElement
  private hintEl!: HTMLSpanElement
  private fileInputEl!: HTMLInputElement
  private attachmentStripEl!: HTMLDivElement
  private pendingAttachments: PendingAttachment[] = []
  private sending = false
  private status: BackendStatusSnapshot = backendSession.getStatus()
  private providers: ProviderState | null = backendSession.getProviders()
  private live: { isStreaming?: boolean; retryState?: RetryState | null } | null = null
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.innerHTML = `
      <form class="composer chat-composer" novalidate>
        <div class="composer-attachments" data-role="attachments" hidden></div>
        <div class="composer-field">
          <button type="button" class="composer-attach" aria-label="Attach image" title="Attach image">${ICON_IMAGE}</button>
          <textarea name="prompt" rows="1" autocapitalize="sentences" required></textarea>
          <button type="submit" class="composer-send" aria-label="Send" title="Send">${ICON_SEND}</button>
        </div>
        <input type="file" class="composer-file-input" accept="image/*" multiple hidden>
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
    this.attachBtn = this.formEl.querySelector<HTMLButtonElement>('.composer-attach')!
    this.abortBtn = this.formEl.querySelector<HTMLButtonElement>('.composer-abort')!
    this.hintEl = this.formEl.querySelector<HTMLSpanElement>('.composer-hint')!
    this.fileInputEl = this.formEl.querySelector<HTMLInputElement>('.composer-file-input')!
    this.attachmentStripEl = this.formEl.querySelector<HTMLDivElement>('[data-role="attachments"]')!
    this.applyPlaceholder()

    this.textareaEl.addEventListener('input', () => {
      autoSizeTextarea(this.textareaEl)
      this.errorEl.classList.add('hidden')
    })
    this.textareaEl.addEventListener('paste', (evt) => {
      const files = filesFromClipboard(evt)
      if (files.length === 0) return
      evt.preventDefault()
      void this.addImageFiles(files)
    })
    this.attachBtn.addEventListener('click', () => {
      if (this.attachBtn.disabled) return
      this.fileInputEl.click()
    })
    this.fileInputEl.addEventListener('change', () => {
      const files = this.fileInputEl.files
      if (files && files.length > 0) void this.addImageFiles(files)
      this.fileInputEl.value = ''
    })
    this.attachmentStripEl.addEventListener('click', (evt) => {
      const btn = (evt.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-attachment]')
      if (!btn) return
      const index = Number(btn.dataset.removeAttachment)
      this.removeAttachment(index)
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
    const attachments = this.pendingAttachments
    if (!prompt && attachments.length === 0) {
      this.errorEl.classList.remove('hidden')
      this.errorEl.textContent = 'Prompt or image is required.'
      this.textareaEl.focus()
      return
    }
    const files = attachments.length > 0
      ? attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      : undefined
    this.sending = true
    this.applyEnabled()
    this.errorEl.classList.add('hidden')
    this.textareaEl.value = ''
    this.pendingAttachments = []
    autoSizeTextarea(this.textareaEl)
    this.renderAttachments()

    const sessionId = this.getAttribute('session-id')
    const providerId = this.getAttribute('provider-id')

    let ok = true
    try {
      if (sessionId) {
        ok = await backendSession.sendFollowup(sessionId, { text: prompt, files })
      } else if (providerId) {
        const newId = await backendSession.sendDraft({ providerId, text: prompt, files })
        ok = newId !== null
      }
    } catch {
      ok = false
    }

    if (!ok && this.isConnected && this.textareaEl.value.length === 0 && this.pendingAttachments.length === 0) {
      // RPC failed (an error event has already been dispatched). Restore
      // the draft so the user can retry; only if they haven't started a
      // new draft in the meantime.
      this.textareaEl.value = prompt
      this.pendingAttachments = [...attachments]
      autoSizeTextarea(this.textareaEl)
      this.renderAttachments()
    }
    this.sending = false
    if (this.isConnected) this.applyEnabled()
  }

  private async addImageFiles(files: File[] | FileList): Promise<void> {
    const images = Array.from(files)
      .map((file) => ({ file, mimeType: imageMimeType(file) }))
      .filter((entry): entry is { file: File; mimeType: string } => entry.mimeType !== null)
    if (images.length === 0) {
      this.errorEl.classList.remove('hidden')
      this.errorEl.textContent = 'Choose an image file.'
      return
    }

    const results = await Promise.all(images.map(async ({ file, mimeType }) => {
      try {
        const data = await readFileAsBase64(file)
        return {
          type: 'file' as const,
          data,
          mimeType,
          name: file.name || 'Image',
          size: file.size,
        }
      } catch (err) {
        console.warn('[chat-input] failed to read attachment', err)
        return null
      }
    }))
    const added = results.filter((a): a is PendingAttachment => a !== null)
    if (added.length === 0) {
      this.errorEl.classList.remove('hidden')
      this.errorEl.textContent = 'Could not read that image.'
      return
    }

    this.pendingAttachments = [...this.pendingAttachments, ...added]
    this.errorEl.classList.add('hidden')
    this.renderAttachments()
    this.applyEnabled()
  }

  private removeAttachment(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pendingAttachments.length) return
    this.pendingAttachments.splice(index, 1)
    this.renderAttachments()
  }

  private renderAttachments(): void {
    const items = this.pendingAttachments
    this.attachmentStripEl.hidden = items.length === 0
    this.attachmentStripEl.innerHTML = items.map((item, index) => {
      const name = escapeHtml(item.name)
      const mimeType = escapeHtml(item.mimeType)
      const data = escapeHtml(item.data)
      return `
        <div class="composer-attachment" title="${name}">
          <img src="data:${mimeType};base64,${data}" alt="${name}">
          <div class="composer-attachment-meta">
            <span>${name}</span>
            <small>${escapeHtml(formatBytes(item.size))}</small>
          </div>
          <button type="button" class="composer-attachment-remove" aria-label="Remove ${name}" data-remove-attachment="${index}">
            <span class="composer-attachment-remove-mark" aria-hidden="true">&times;</span>
          </button>
        </div>
      `
    }).join('')
  }

  private applyEnabled() {
    const reason = this.disabledReason()
    const canSend = reason === null
    this.textareaEl.disabled = !canSend
    this.submitBtn.disabled = !canSend || this.sending
    this.attachBtn.disabled = this.sending
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
    if (isDraft) {
      const providerId = this.getAttribute('provider-id')
      if (providerId && !this.providers?.providerList.some((provider) => provider.id === providerId)) {
        return 'Selected provider is no longer available.'
      }
    }
    return null
  }
}

function filesFromClipboard(evt: ClipboardEvent): File[] {
  const out: File[] = []
  const items = evt.clipboardData?.items
  if (!items) return out
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}

function imageMimeType(file: File): string | null {
  if (file.type.startsWith('image/')) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'heic': return 'image/heic'
    case 'heif': return 'image/heif'
    default: return null
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader result was not a string'))
        return
      }
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
}
