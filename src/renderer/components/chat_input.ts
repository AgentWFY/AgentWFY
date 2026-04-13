import { escapeHtml, imageDataUrl } from './chat_utils.js'
import { agentSessionStore } from '../stores/agent-session-store.js'
import type { FileContent } from '../../agent/types.js'

type PendingAttachment = FileContent & { name: string }

const STYLES = `
  awfy-chat-input {
    display: block;
    flex-shrink: 0;
  }
  .input-container {
    position: relative;
    border: 1px solid var(--color-input-border);
    border-radius: var(--radius-md);
    background: var(--color-input-bg);
    transition: border-color var(--transition-fast);
  }
  .input-container:focus-within {
    border-color: var(--color-focus-border);
  }
  .input-container textarea {
    display: block;
    width: 100%;
    resize: none;
    min-height: 36px;
    max-height: 120px;
    line-height: 1.4;
    overflow-y: auto;
    border: none;
    background: transparent;
    padding: 8px 40px 8px 10px;
    outline: none;
    box-sizing: border-box;
  }
  .paste-attachment {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 8px 0;
    padding: 4px 8px;
    background: var(--color-bg3);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--color-text3);
    cursor: pointer;
    user-select: none;
  }
  .paste-attachment:hover {
    background: var(--color-item-hover);
  }
  .paste-attachment-icon {
    flex-shrink: 0;
    color: var(--color-text2);
  }
  .paste-attachment-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .paste-attachment-remove {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-text2);
    font-size: 14px;
    line-height: 1;
    display: flex;
    align-items: center;
  }
  .paste-attachment-remove:hover {
    color: var(--color-red-fg);
  }
  .paste-attachment-preview {
    margin: 0 8px 6px;
    padding: 6px 8px;
    background: var(--color-bg3);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.4;
    color: var(--color-text2);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 150px;
    overflow-y: auto;
  }
  .attachment-strip {
    display: none;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 8px 0;
  }
  .attachment-strip.has-items {
    display: flex;
  }
  .attachment-item {
    position: relative;
    width: 52px;
    height: 52px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--color-border);
    background: var(--color-bg3);
    flex-shrink: 0;
  }
  .attachment-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .attachment-item-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 16px;
    height: 16px;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .attachment-item-remove:hover {
    background: var(--color-red-fg);
  }
  .input-container.drag-over {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-input-bg));
  }
  .stop-btn {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-text3);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--color-bg1);
    padding: 0;
    transition: background var(--transition-fast);
  }
  .stop-btn:hover {
    background: var(--color-red-fg);
  }
`

const PASTE_THRESHOLD = 500

interface InputStateCache {
  inputValue: string
  pastedText: string | null
  pastedLineCount: number
  pasteExpanded: boolean
  pendingAttachments: PendingAttachment[]
}

export class TlChatInput extends HTMLElement {
  private _styleEl: HTMLStyleElement | null = null
  private _containerEl: HTMLElement | null = null
  private _textarea: HTMLTextAreaElement | null = null
  private _stopBtn: HTMLElement | null = null
  private _inputValue = ''
  private _pastedText: string | null = null
  private _pastedLineCount = 0
  private _pasteExpanded = false
  private _pendingAttachments: PendingAttachment[] = []
  private _pasteAttachmentEl: HTMLElement | null = null
  private _pasteLabelEl: HTMLElement | null = null
  private _pastePreviewEl: HTMLElement | null = null
  private _attachmentStripEl: HTMLElement | null = null
  private _fileInputEl: HTMLInputElement | null = null
  private _storeUnsub: (() => void) | null = null

  // Per-agent state cache
  private _inputStateCache = new Map<string, InputStateCache>()
  private _currentAgentRoot: string | null = null

  connectedCallback() {
    this._styleEl = document.createElement('style')
    this._styleEl.textContent = STYLES
    this.appendChild(this._styleEl)

    this._currentAgentRoot = window.ipc?.agentRoot ?? null
    this.buildLayout()

    this._storeUnsub = agentSessionStore.select(
      s => s.isStreaming,
      (isStreaming) => {
        if (this._stopBtn) this._stopBtn.style.display = isStreaming ? '' : 'none'
        if (this._textarea) {
          const p = isStreaming ? 'Send follow-up message...' : 'Type your message here...'
          if (this._textarea.placeholder !== p) this._textarea.placeholder = p
        }
      }
    )

    window.addEventListener('agentwfy:agent-switched', this._onAgentSwitched)
  }

  disconnectedCallback() {
    this._storeUnsub?.()
    this._storeUnsub = null
    window.removeEventListener('agentwfy:agent-switched', this._onAgentSwitched)
  }

  focusInput() {
    this._textarea?.focus()
  }

  triggerFileSelect() {
    this._fileInputEl?.click()
  }

  private _onAgentSwitched = (e: Event) => {
    const detail = (e as CustomEvent).detail
    const newAgentRoot: string | null = detail?.agentRoot ?? null
    const agents: Array<{ path: string }> | undefined = detail?.agents

    if (newAgentRoot === this._currentAgentRoot) return

    if (this._currentAgentRoot) {
      this._inputStateCache.set(this._currentAgentRoot, {
        inputValue: this._inputValue,
        pastedText: this._pastedText,
        pastedLineCount: this._pastedLineCount,
        pasteExpanded: this._pasteExpanded,
        pendingAttachments: [...this._pendingAttachments],
      })
    }

    const cached = newAgentRoot ? this._inputStateCache.get(newAgentRoot) : null
    if (cached) {
      this._inputValue = cached.inputValue
      this._pastedText = cached.pastedText
      this._pastedLineCount = cached.pastedLineCount
      this._pasteExpanded = cached.pasteExpanded
      this._pendingAttachments = [...cached.pendingAttachments]
    } else {
      this._inputValue = ''
      this._pastedText = null
      this._pastedLineCount = 0
      this._pasteExpanded = false
      this._pendingAttachments = []
    }

    if (agents) {
      const activePaths = new Set(agents.map(a => a.path))
      for (const key of this._inputStateCache.keys()) {
        if (!activePaths.has(key)) this._inputStateCache.delete(key)
      }
    }

    if (this._textarea) {
      this._textarea.value = this._inputValue
      this._textarea.style.height = 'auto'
    }
    this.renderPasteAttachment()
    this.renderAttachmentStrip()

    this._currentAgentRoot = newAgentRoot
  }

  private buildLayout() {
    this._containerEl = document.createElement('div')
    this._containerEl.className = 'input-container'

    // Drag-and-drop
    let dragDepth = 0
    this._containerEl.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragDepth++
      this._containerEl!.classList.add('drag-over')
    })
    this._containerEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    this._containerEl.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) this._containerEl!.classList.remove('drag-over')
    })
    this._containerEl.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      dragDepth = 0
      this._containerEl!.classList.remove('drag-over')
      void this.addImageFiles(e.dataTransfer.files)
    })

    // Attachment strip
    this._attachmentStripEl = document.createElement('div')
    this._attachmentStripEl.className = 'attachment-strip'
    this._attachmentStripEl.addEventListener('mousedown', (ev) => {
      const removeBtn = (ev.target as HTMLElement).closest('.attachment-item-remove') as HTMLElement | null
      if (!removeBtn) return
      ev.preventDefault()
      ev.stopPropagation()
      const idx = parseInt(removeBtn.dataset.removeIdx ?? '-1', 10)
      this.removeAttachment(idx)
      this._textarea?.focus()
    })
    this._containerEl.appendChild(this._attachmentStripEl)

    // Paste attachment
    this._pasteAttachmentEl = document.createElement('div')
    this._pasteAttachmentEl.className = 'paste-attachment'
    this._pasteAttachmentEl.style.display = 'none'

    const pasteIcon = document.createElement('span')
    pasteIcon.className = 'paste-attachment-icon'
    pasteIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1h-1.5"/><rect x="5" y="1" width="6" height="3" rx="1"/></svg>'
    this._pasteAttachmentEl.appendChild(pasteIcon)

    this._pasteLabelEl = document.createElement('span')
    this._pasteLabelEl.className = 'paste-attachment-label'
    this._pasteAttachmentEl.appendChild(this._pasteLabelEl)

    const pasteRemoveBtn = document.createElement('button')
    pasteRemoveBtn.className = 'paste-attachment-remove'
    pasteRemoveBtn.title = 'Remove pasted text'
    pasteRemoveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>'
    pasteRemoveBtn.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      this.removePasteAttachment()
      this._textarea?.focus()
    })
    this._pasteAttachmentEl.appendChild(pasteRemoveBtn)

    this._pasteAttachmentEl.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.paste-attachment-remove')) return
      this._pasteExpanded = !this._pasteExpanded
      this.renderPasteAttachment()
    })
    this._containerEl.appendChild(this._pasteAttachmentEl)

    this._pastePreviewEl = document.createElement('div')
    this._pastePreviewEl.className = 'paste-attachment-preview'
    this._pastePreviewEl.style.display = 'none'
    this._containerEl.appendChild(this._pastePreviewEl)

    // Textarea
    this._textarea = document.createElement('textarea')
    this._textarea.id = 'msg-input'
    this._textarea.rows = 1
    this._textarea.placeholder = agentSessionStore.state.isStreaming
      ? 'Send follow-up message...'
      : 'Type your message here...'
    this._textarea.value = this._inputValue
    this._textarea.addEventListener('keydown', (e) => this.handleKeydown(e))
    this._textarea.addEventListener('input', (e) => this.handleInput(e))
    this._textarea.addEventListener('paste', (e) => this.handlePaste(e))
    this._containerEl.appendChild(this._textarea)

    this.renderPasteAttachment()

    // Stop button
    this._stopBtn = document.createElement('button')
    this._stopBtn.className = 'stop-btn'
    this._stopBtn.title = 'Stop'
    this._stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="1.5" fill="currentColor"/></svg>'
    this._stopBtn.style.display = agentSessionStore.state.isStreaming ? '' : 'none'
    this._stopBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.handleStop()
    })
    this._containerEl.appendChild(this._stopBtn)

    // Hidden file input
    this._fileInputEl = document.createElement('input')
    this._fileInputEl.type = 'file'
    this._fileInputEl.accept = 'image/*'
    this._fileInputEl.multiple = true
    this._fileInputEl.style.display = 'none'
    this._fileInputEl.addEventListener('change', () => {
      const files = this._fileInputEl?.files
      if (files && files.length > 0) {
        void this.addImageFiles(files)
      }
      if (this._fileInputEl) this._fileInputEl.value = ''
    })
    this.appendChild(this._fileInputEl)

    this.appendChild(this._containerEl)
  }

  private async sendMessage() {
    const typed = this._inputValue.trim()
    const pasted = this._pastedText
    const attachments = this._pendingAttachments
    if (!typed && !pasted && attachments.length === 0) return

    let text: string
    if (pasted && typed) {
      text = typed + '\n\n<context>\n' + pasted + '\n</context>'
    } else if (pasted) {
      text = pasted
    } else {
      text = typed
    }

    const files: FileContent[] | undefined = attachments.length > 0
      ? attachments.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
      : undefined

    this._inputValue = ''
    this._pastedText = null
    this._pastedLineCount = 0
    this._pasteExpanded = false
    this._pendingAttachments = []
    if (this._textarea) {
      this._textarea.value = ''
      this._textarea.style.height = 'auto'
    }
    this.renderPasteAttachment()
    this.renderAttachmentStrip()

    this.dispatchEvent(new CustomEvent('chat-send', { bubbles: true }))

    try {
      await agentSessionStore.sendMessage(text, files)
    } catch (e) {
      this.dispatchEvent(new CustomEvent('chat-error', {
        bubbles: true,
        detail: { message: e instanceof Error ? e.message : String(e) }
      }))
    }
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      this.sendMessage()
    } else if (e.key === 'Enter' && e.shiftKey) {
      requestAnimationFrame(() => this.autoResizeTextarea(e.target as HTMLTextAreaElement))
    }
  }

  private handleInput(e: Event) {
    const textarea = e.target as HTMLTextAreaElement
    this._inputValue = textarea.value
    this.autoResizeTextarea(textarea)
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement) {
    textarea.style.height = 'auto'
    textarea.style.height = textarea.scrollHeight + 'px'
  }

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (items) {
      const imageFiles: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        void this.addImageFiles(imageFiles)
        return
      }
    }

    const text = e.clipboardData?.getData('text/plain')
    if (!text || text.length < PASTE_THRESHOLD) return

    e.preventDefault()
    this._pastedText = text
    this._pastedLineCount = 1
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this._pastedLineCount++
    }
    this._pasteExpanded = false
    this.renderPasteAttachment()
  }

  private async addImageFiles(files: File[] | FileList): Promise<void> {
    const images = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (images.length === 0) return
    const results = await Promise.all(images.map(async (file) => {
      try {
        const data = await this.readFileAsBase64(file)
        return { type: 'file' as const, data, mimeType: file.type, name: file.name || 'image' }
      } catch (err) {
        console.warn('[chat-input] failed to read attachment', err)
        return null
      }
    }))
    const added = results.filter((a): a is PendingAttachment => a !== null)
    if (added.length === 0) return
    this._pendingAttachments = [...this._pendingAttachments, ...added]
    this.renderAttachmentStrip()
  }

  private readFileAsBase64(file: File): Promise<string> {
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

  private removeAttachment(index: number): void {
    if (index < 0 || index >= this._pendingAttachments.length) return
    this._pendingAttachments.splice(index, 1)
    this.renderAttachmentStrip()
  }

  private renderAttachmentStrip(): void {
    if (!this._attachmentStripEl) return
    const items = this._pendingAttachments
    if (items.length === 0) {
      this._attachmentStripEl.classList.remove('has-items')
      this._attachmentStripEl.innerHTML = ''
      return
    }
    this._attachmentStripEl.classList.add('has-items')
    this._attachmentStripEl.innerHTML = items.map((att, i) => {
      const name = escapeHtml(att.name)
      return `<div class="attachment-item" data-idx="${i}" title="${name}">
        <img src="${imageDataUrl(att.mimeType, att.data)}" alt="${name}">
        <button class="attachment-item-remove" data-remove-idx="${i}" title="Remove">
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
        </button>
      </div>`
    }).join('')
  }

  private removePasteAttachment() {
    this._pastedText = null
    this._pastedLineCount = 0
    this._pasteExpanded = false
    this.renderPasteAttachment()
  }

  private renderPasteAttachment() {
    if (!this._pasteAttachmentEl || !this._pastePreviewEl) return

    if (!this._pastedText) {
      this._pasteAttachmentEl.style.display = 'none'
      this._pastePreviewEl.style.display = 'none'
      this._pastePreviewEl.textContent = ''
      return
    }

    const lines = this._pastedLineCount
    const chars = this._pastedText.length
    if (this._pasteLabelEl) {
      this._pasteLabelEl.textContent = `Pasted text \u2014 ${lines} line${lines !== 1 ? 's' : ''}, ${chars.toLocaleString()} chars`
    }

    this._pasteAttachmentEl.style.display = 'flex'

    if (this._pasteExpanded) {
      this._pastePreviewEl.style.display = 'block'
      this._pastePreviewEl.textContent = this._pastedText
    } else {
      this._pastePreviewEl.style.display = 'none'
      this._pastePreviewEl.textContent = ''
    }
  }

  private async handleStop() {
    try {
      await agentSessionStore.abort()
    } catch (e) {
      this.dispatchEvent(new CustomEvent('chat-error', {
        bubbles: true,
        detail: { message: e instanceof Error ? e.message : String(e) }
      }))
    }
  }
}
