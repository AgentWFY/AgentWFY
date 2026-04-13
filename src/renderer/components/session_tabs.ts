import { agentSessionStore } from '../stores/agent-session-store.js'

const STYLES = `
  awfy-session-tabs {
    display: block;
    flex-shrink: 0;
  }
  .open-sessions-box {
    flex-shrink: 0;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: 4px;
    margin-bottom: 4px;
  }
  .session-list-header {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    cursor: pointer;
    user-select: none;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text2);
  }
  .session-list-header:hover {
    color: var(--color-text3);
  }
  .session-list-header svg {
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .session-list-header.collapsed svg {
    transform: rotate(-90deg);
  }
  .session-list {
    display: flex;
    flex-direction: column;
  }
  .session-list.collapsed {
    display: none;
  }
  .session-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .session-item:hover {
    background: var(--color-item-hover);
  }
  .session-item.active {
    background: var(--color-item-hover);
  }
  .session-item-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text2);
    opacity: 0.5;
    flex-shrink: 0;
  }
  .session-item.active .session-item-dot {
    background: var(--color-text3);
    opacity: 1;
  }
  .session-item.streaming .session-item-dot {
    background: var(--color-green-fg);
    opacity: 1;
    animation: st-pulse 1.5s ease-in-out infinite;
  }
  @keyframes st-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .session-item-label {
    font-size: 12px;
    color: var(--color-text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .session-item.active .session-item-label {
    font-weight: 600;
    color: var(--color-text4);
  }
  .session-item-close {
    display: none;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border: none;
    background: none;
    cursor: pointer;
    border-radius: 3px;
    padding: 0;
    color: var(--color-text2);
  }
  .session-item-close:hover {
    background: var(--color-item-active);
    color: var(--color-text4);
  }
  .session-item:hover .session-item-close {
    display: flex;
  }
  /* ── Zen mode: horizontal session tabs ── */
  .awfy-app-root.zen-mode .open-sessions-box {
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 0;
  }
  .awfy-app-root.zen-mode .session-list-header {
    display: none;
  }
  .awfy-app-root.zen-mode .session-list,
  .awfy-app-root.zen-mode .session-list.collapsed {
    display: flex;
    flex-direction: row;
    overflow-x: auto;
    gap: 4px;
    padding: 4px 4px 4px 72px; /* macOS traffic light buttons */
  }
  .awfy-app-root.zen-mode .session-item {
    padding: 0 10px;
    height: 28px;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text2);
    font-size: 12px;
    flex-shrink: 0;
    max-width: 200px;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .awfy-app-root.zen-mode .session-item:hover {
    color: var(--color-text3);
    background: var(--color-item-hover);
  }
  .awfy-app-root.zen-mode .session-item.active {
    color: var(--color-text4);
    background: var(--color-bg1);
    font-weight: 500;
    box-shadow: 0 0 2px rgba(0,0,0,0.08), 0 0 0 0.5px rgba(0,0,0,0.04);
  }
  .awfy-app-root.zen-mode .session-item-dot {
    display: block;
    opacity: 0.45;
  }
  .awfy-app-root.zen-mode .session-item.active .session-item-dot {
    opacity: 0.75;
  }
  .awfy-app-root.zen-mode .session-item:hover .session-item-dot {
    opacity: 0.65;
  }
  .awfy-app-root.zen-mode .session-item.streaming .session-item-dot {
    opacity: 1;
  }
  .awfy-app-root.zen-mode .session-item.active .session-item-label {
    font-weight: 500;
  }
  .awfy-app-root.zen-mode .session-item-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    visibility: hidden;
  }
  .awfy-app-root.zen-mode .session-item:hover .session-item-close {
    visibility: visible;
  }
`

const CLOSE_SVG = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>'

export class TlSessionTabs extends HTMLElement {
  private _styleEl: HTMLStyleElement | null = null
  private _openBox: HTMLElement | null = null
  private _sessionListEl: HTMLElement | null = null
  private _sessionCountEl: HTMLElement | null = null
  private _isZenMode = false
  private _unsubs: (() => void)[] = []
  private _unlistenZenMode: (() => void) | null = null
  private _updatePending = false

  connectedCallback() {
    this._styleEl = document.createElement('style')
    this._styleEl.textContent = STYLES
    this.appendChild(this._styleEl)

    this.buildLayout()
    this.subscribeToStore()

    this._unlistenZenMode = window.ipc?.zenMode?.onChanged((isZen: boolean) => {
      this._isZenMode = isZen
      this.update()
    }) ?? null

    this.update()
  }

  disconnectedCallback() {
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
    this._unlistenZenMode?.()
    this._unlistenZenMode = null
  }

  private buildLayout() {
    this._openBox = document.createElement('div')
    this._openBox.className = 'open-sessions-box'
    this._openBox.style.display = 'none'

    const header = document.createElement('div')
    header.className = 'session-list-header'
    header.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,3 5,7 8,3"/></svg><span></span>'
    this._sessionCountEl = header.querySelector('span')
    header.addEventListener('mousedown', (e) => {
      e.preventDefault()
      header.classList.toggle('collapsed')
      this._sessionListEl?.classList.toggle('collapsed')
    })
    this._openBox.appendChild(header)

    this._sessionListEl = document.createElement('div')
    this._sessionListEl.className = 'session-list'
    this._sessionListEl.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement
      const closeBtn = target.closest('.session-item-close') as HTMLElement | null
      if (closeBtn) {
        e.preventDefault()
        e.stopPropagation()
        const item = closeBtn.closest('.session-item') as HTMLElement | null
        if (item) {
          const idx = parseInt(item.dataset.idx!, 10)
          const session = agentSessionStore.state.openSessions[idx]
          if (session) agentSessionStore.removeOpenSession(session.file)
        }
        return
      }
      const item = target.closest('.session-item') as HTMLElement | null
      if (item) {
        e.preventDefault()
        const idx = parseInt(item.dataset.idx!, 10)
        const session = agentSessionStore.state.openSessions[idx]
        if (session && session.file !== agentSessionStore.state.activeSessionFile) {
          this.loadSession(session.file)
        }
      }
    })
    this._sessionListEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const item = (e.target as HTMLElement).closest('.session-item') as HTMLElement | null
      if (item) {
        e.preventDefault()
        const idx = parseInt(item.dataset.idx!, 10)
        const session = agentSessionStore.state.openSessions[idx]
        if (session) agentSessionStore.removeOpenSession(session.file)
      }
    })
    this._openBox.appendChild(this._sessionListEl)
    this.appendChild(this._openBox)
  }

  private scheduleUpdate() {
    if (this._updatePending) return
    this._updatePending = true
    requestAnimationFrame(() => {
      this._updatePending = false
      this.update()
    })
  }

  private subscribeToStore() {
    this._unsubs.push(agentSessionStore.select(s => s.openSessions, () => this.scheduleUpdate()))
    this._unsubs.push(agentSessionStore.select(s => s.activeSessionFile, () => this.scheduleUpdate()))
    this._unsubs.push(agentSessionStore.select(s => s.streamingFiles, () => this.scheduleUpdate()))
    this._unsubs.push(agentSessionStore.select(s => s.label, () => this.scheduleUpdate()))
    this._unsubs.push(agentSessionStore.select(s => s.messages, () => this.scheduleUpdate()))
    this._unsubs.push(agentSessionStore.select(s => s.isStreaming, () => this.scheduleUpdate()))
  }

  private update() {
    if (!this._sessionListEl || !this._openBox) return
    const s = agentSessionStore.state
    const open = s.openSessions
    const hasMessages = s.messages.length > 0 || s.isStreaming

    if (!this._isZenMode && open.length <= 1 && hasMessages) {
      this._openBox.style.display = 'none'
      return
    }
    if (open.length === 0) {
      this._openBox.style.display = 'none'
      return
    }

    this._openBox.style.display = ''
    if (this._sessionCountEl) this._sessionCountEl.textContent = `${open.length} sessions`

    const activeFile = s.activeSessionFile
    const streamingSet = new Set(s.streamingFiles)

    const existing = Array.from(this._sessionListEl.querySelectorAll('.session-item')) as HTMLElement[]
    while (existing.length > open.length) {
      existing.pop()!.remove()
    }
    while (existing.length < open.length) {
      const item = document.createElement('div')
      item.className = 'session-item'
      item.innerHTML = `<span class="session-item-dot"></span><span class="session-item-label"></span><button class="session-item-close">${CLOSE_SVG}</button>`
      this._sessionListEl.appendChild(item)
      existing.push(item)
    }

    for (let i = 0; i < open.length; i++) {
      const item = existing[i]
      const isActive = open[i].file === activeFile
      const isStreaming = streamingSet.has(open[i].file)
      item.className = 'session-item'
        + (isActive ? ' active' : '')
        + (isStreaming ? ' streaming' : '')
      item.dataset.idx = String(i)
      const label = item.querySelector('.session-item-label') as HTMLElement
      if (label) label.textContent = isActive ? (s.label || 'New Session') : open[i].label
    }
  }

  private loadSession(file: string) {
    agentSessionStore.loadSession(file).catch(err => {
      this.dispatchEvent(new CustomEvent('session-error', {
        bubbles: true,
        detail: { message: err instanceof Error ? err.message : String(err) }
      }))
    })
  }
}
