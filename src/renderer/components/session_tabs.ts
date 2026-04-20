import { agentSessionStore } from '../stores/agent-session-store.js'

const COLLAPSE_THRESHOLD = 2

const STYLES = `
  awfy-session-tabs {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 3px;
    border-bottom: 1px solid var(--color-divider);
    background: var(--color-bg2);
    flex-shrink: 0;
  }
  .awfy-st-list {
    display: flex;
    gap: 3px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    min-width: 0;
    flex: 1;
  }
  .awfy-st-list::-webkit-scrollbar { display: none; }
  .awfy-st-list.overflowing {
    -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 12px), transparent 100%);
            mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 12px), transparent 100%);
  }
  .awfy-st-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    box-sizing: border-box;
    max-width: 130px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg1);
    color: var(--color-text1);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
    transition: border-color var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .awfy-st-tab:hover {
    color: var(--color-text3);
  }
  .awfy-st-tab.active {
    color: var(--color-text4);
    font-weight: 500;
    border-color: var(--color-text2);
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  }
  .awfy-st-tab.collapsed {
    width: 20px;
    max-width: 20px;
    padding: 0;
    justify-content: center;
  }
  .awfy-st-tab.collapsed .awfy-st-label {
    display: none;
  }
  .awfy-st-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    flex-shrink: 0;
  }
  .awfy-st-tab.active .awfy-st-dot {
    background: var(--color-green-fg);
  }
  .awfy-st-dot.streaming {
    background: var(--color-accent);
    animation: awfy-st-stream 1.2s ease-in-out infinite;
  }
  @keyframes awfy-st-stream {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.7); }
  }
  .awfy-st-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .awfy-st-new {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--color-text2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .awfy-st-new:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .awfy-st-new svg { display: block; }
`

const PLUS_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'

export class TlSessionTabs extends HTMLElement {
  private _styleEl: HTMLStyleElement | null = null
  private _listEl: HTMLElement | null = null
  private _newBtn: HTMLButtonElement | null = null
  private _unsubs: (() => void)[] = []
  private _updatePending = false
  private _maskPending = false
  private _resizeObserver: ResizeObserver | null = null

  connectedCallback() {
    this._styleEl = document.createElement('style')
    this._styleEl.textContent = STYLES
    this.appendChild(this._styleEl)

    this.buildLayout()
    this.subscribeToStore()
    this.update()

    this._resizeObserver = new ResizeObserver(() => this.scheduleMaskUpdate())
    this._resizeObserver.observe(this)
  }

  disconnectedCallback() {
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
    this._resizeObserver?.disconnect()
    this._resizeObserver = null
  }

  private buildLayout() {
    this._listEl = document.createElement('div')
    this._listEl.className = 'awfy-st-list'
    this._listEl.addEventListener('mousedown', (e) => {
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (!item) return
      e.preventDefault()
      const idx = parseInt(item.dataset.idx!, 10)
      const session = agentSessionStore.state.openSessions[idx]
      if (session && session.file !== agentSessionStore.state.activeSessionFile) {
        this.loadSession(session.file)
      }
    })
    this._listEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (item) {
        e.preventDefault()
        const idx = parseInt(item.dataset.idx!, 10)
        const session = agentSessionStore.state.openSessions[idx]
        if (session) agentSessionStore.removeOpenSession(session.file)
      }
    })
    this._listEl.addEventListener('contextmenu', (e) => {
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (!item) return
      e.preventDefault()
      const idx = parseInt(item.dataset.idx!, 10)
      const session = agentSessionStore.state.openSessions[idx]
      if (session) agentSessionStore.removeOpenSession(session.file)
    })
    this.appendChild(this._listEl)

    this._newBtn = document.createElement('button')
    this._newBtn.className = 'awfy-st-new'
    this._newBtn.title = 'New session'
    this._newBtn.innerHTML = PLUS_SVG
    this._newBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.createSession()
    })
    this.appendChild(this._newBtn)
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
  }

  private update() {
    if (!this._listEl) return
    const s = agentSessionStore.state
    const open = s.openSessions

    // Hide the strip entirely when empty — a lone + button looks orphaned.
    this.style.display = open.length === 0 ? 'none' : ''
    if (open.length === 0) return

    const activeFile = s.activeSessionFile
    const streamingSet = new Set(s.streamingFiles)
    const collapseInactive = open.length > COLLAPSE_THRESHOLD

    const existing = Array.from(this._listEl.querySelectorAll('.awfy-st-tab')) as HTMLElement[]
    while (existing.length > open.length) {
      existing.pop()!.remove()
    }
    while (existing.length < open.length) {
      const item = document.createElement('div')
      item.className = 'awfy-st-tab'
      item.innerHTML = `<span class="awfy-st-dot"></span><span class="awfy-st-label"></span>`
      this._listEl.appendChild(item)
      existing.push(item)
    }

    for (let i = 0; i < open.length; i++) {
      const item = existing[i]
      const isActive = open[i].file === activeFile
      const isStreaming = streamingSet.has(open[i].file)
      const labelText = isActive ? (s.label || 'New session') : open[i].label
      item.className = 'awfy-st-tab'
        + (isActive ? ' active' : '')
        + (!isActive && collapseInactive ? ' collapsed' : '')
      item.dataset.idx = String(i)
      item.title = labelText
      const dot = item.querySelector('.awfy-st-dot') as HTMLElement | null
      if (dot) dot.className = 'awfy-st-dot' + (isStreaming ? ' streaming' : '')
      const label = item.querySelector('.awfy-st-label') as HTMLElement | null
      if (label) label.textContent = labelText
    }

    this.scheduleMaskUpdate()
  }

  private scheduleMaskUpdate() {
    if (this._maskPending) return
    this._maskPending = true
    requestAnimationFrame(() => {
      this._maskPending = false
      if (!this._listEl) return
      const overflowing = this._listEl.scrollWidth > this._listEl.clientWidth + 1
      this._listEl.classList.toggle('overflowing', overflowing)
    })
  }

  private loadSession(file: string) {
    agentSessionStore.loadSession(file).catch(err => {
      this.dispatchEvent(new CustomEvent('session-error', {
        bubbles: true,
        detail: { message: err instanceof Error ? err.message : String(err) }
      }))
    })
  }

  private createSession() {
    agentSessionStore.createSession().catch(err => {
      this.dispatchEvent(new CustomEvent('session-error', {
        bubbles: true,
        detail: { message: err instanceof Error ? err.message : String(err) }
      }))
    })
  }
}
