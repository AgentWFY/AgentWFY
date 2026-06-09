// Shared formatting and DOM helpers used across the mobile renderer.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return ch
    }
  })
}

export function formatDuration(ms: number): string {
  const sec = Math.ceil(Math.max(0, ms) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'unknown size'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatRelative(ts: number): string {
  if (!ts) return 'unknown'
  const delta = Date.now() - ts
  if (delta < 0) return 'just now'
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

export function displayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function autoSizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(140, Math.max(36, textarea.scrollHeight))}px`
}

export interface ConfirmationOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function requestConfirmation(options: ConfirmationOptions): Promise<boolean> {
  const previousActive = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const backdrop = document.createElement('div')
  backdrop.className = 'confirm-backdrop'
  backdrop.innerHTML = `
    <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">${escapeHtml(options.title)}</h2>
      <p>${escapeHtml(options.message)}</p>
      <div class="confirm-actions">
        <button type="button" class="btn ghost" data-role="cancel">${escapeHtml(options.cancelLabel ?? 'Cancel')}</button>
        <button type="button" class="btn ${options.danger ? 'danger' : 'primary'}" data-role="confirm">${escapeHtml(options.confirmLabel ?? 'OK')}</button>
      </div>
    </div>
  `

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeyDown)
      backdrop.remove()
      previousActive?.focus()
      resolve(value)
    }
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key === 'Escape') finish(false)
    }

    backdrop.addEventListener('click', (evt) => {
      if (evt.target === backdrop) finish(false)
    })
    backdrop.querySelector<HTMLButtonElement>('[data-role="cancel"]')?.addEventListener('click', () => finish(false))
    backdrop.querySelector<HTMLButtonElement>('[data-role="confirm"]')?.addEventListener('click', () => finish(true))
    document.addEventListener('keydown', onKeyDown)
    document.body.appendChild(backdrop)
    queueMicrotask(() => {
      backdrop.querySelector<HTMLButtonElement>('[data-role="confirm"]')?.focus()
    })
  })
}
