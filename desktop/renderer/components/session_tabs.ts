import { listen } from '../events.js'
import { agentSession, type AgentSessionState } from '../services/agent-session.js'

// Width budget for the fit pass. A title squeezed below LABEL_MIN is too short
// to tell sessions apart, so that tab falls back to a dot instead.
const ACTIVE_MIN = 104
const LABEL_MIN = 72
const LABEL_MAX = 180
const DOT_SIZE = 22
const GAP = 2
// Everything in a tab that isn't its title: padding, border, dot, dot gap.
const TAB_CHROME = 23

const STYLES = `
  awfy-session-tabs {
    display: flex;
    align-items: center;
    gap: ${GAP}px;
    padding: 3px;
    border-bottom: 1px solid var(--color-divider);
    background: var(--color-bg2);
    flex-shrink: 0;
  }
  .awfy-st-list {
    display: flex;
    gap: ${GAP}px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    min-width: 0;
    flex: 1;
  }
  .awfy-st-list::-webkit-scrollbar { display: none; }
  .awfy-st-list.fade-start, .awfy-st-list.fade-end {
    -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--fade-start, 0px), #000 calc(100% - var(--fade-end, 0px)), transparent);
            mask-image: linear-gradient(to right, transparent, #000 var(--fade-start, 0px), #000 calc(100% - var(--fade-end, 0px)), transparent);
  }
  .awfy-st-list.fade-start { --fade-start: 12px; }
  .awfy-st-list.fade-end { --fade-end: 12px; }
  /* Tabs start from their minimum and split the spare width evenly, each one
     stopping at its full title — so short titles don't hoard space. */
  .awfy-st-tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    height: ${DOT_SIZE}px;
    padding: 0 6px;
    box-sizing: border-box;
    flex: 1 1 ${LABEL_MIN}px;
    min-width: ${DOT_SIZE}px;
    max-width: max-content;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    color: var(--color-text1);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    user-select: none;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }
  .awfy-st-tab:hover {
    background: var(--color-item-hover);
    color: var(--color-text3);
  }
  .awfy-st-tab.active {
    flex: 1 0 ${ACTIVE_MIN}px;
    background: var(--color-surface);
    border-color: var(--color-border);
    color: var(--color-text4);
    font-weight: 500;
  }
  .awfy-st-tab.collapsed {
    flex: 0 0 ${DOT_SIZE}px;
    max-width: none;
    padding: 0;
    justify-content: center;
  }
  /* Out of flow rather than display:none, so fit() can still measure it. */
  .awfy-st-tab.collapsed .awfy-st-label {
    position: absolute;
    visibility: hidden;
  }
  .awfy-st-tab.collapsed .awfy-st-close {
    display: none;
  }
  .awfy-st-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    opacity: 0.6;
    flex-shrink: 0;
  }
  .awfy-st-dot.unseen {
    background: var(--color-green-fg);
    opacity: 1;
  }
  .awfy-st-dot.streaming {
    background: var(--color-accent);
    opacity: 1;
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
    max-width: ${LABEL_MAX}px;
  }
  /* The close button floats over the end of the title instead of reserving
     room for itself, so the title fades out underneath it. */
  .awfy-st-tab:hover .awfy-st-label {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent calc(100% - 12px));
            mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent calc(100% - 12px));
  }
  .awfy-st-close {
    position: absolute;
    top: 50%;
    right: 3px;
    width: 14px;
    height: 14px;
    margin-top: -7px;
    border-radius: 3px;
    color: var(--color-text2);
    display: none;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .awfy-st-tab:hover .awfy-st-close { display: flex; }
  .awfy-st-close:hover {
    background: var(--color-item-active);
    color: var(--color-text4);
  }
  .awfy-st-close svg { display: block; }
  .awfy-st-new {
    width: ${DOT_SIZE}px;
    height: ${DOT_SIZE}px;
    border-radius: var(--radius-md);
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
const CLOSE_SVG = '<svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>'

export class TlSessionTabs extends HTMLElement {
  private _styleEl: HTMLStyleElement | null = null
  private _listEl: HTMLElement | null = null
  private _newBtn: HTMLButtonElement | null = null
  private _unsubs: (() => void)[] = []
  private _updatePending = false
  private _fitPending = false
  private _resizeObserver: ResizeObserver | null = null
  /** Sessions in the order they were last viewed, most recent last. Decides
   *  which tabs give up their title first when the strip runs out of room. */
  private _recency: string[] = []
  /** Sessions that finished a turn while another one was in view. */
  private _unseen = new Set<string>()
  private _wasStreaming = new Set<string>()
  private _shownActiveId: string | null = null

  connectedCallback() {
    this._styleEl = document.createElement('style')
    this._styleEl.textContent = STYLES
    this.appendChild(this._styleEl)

    this.buildLayout()
    this.subscribeToEvents()
    this.update()

    this._resizeObserver = new ResizeObserver(() => this.scheduleFit())
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
      if (e.button !== 0) return
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (!item) return
      e.preventDefault()
      const idx = parseInt(item.dataset.idx!, 10)
      const session = agentSession.state.openSessions[idx]
      if (!session) return
      if ((e.target as HTMLElement).closest('.awfy-st-close')) {
        agentSession.removeOpenSession(session.sessionId)
      } else if (session.sessionId !== agentSession.state.activeSessionId) {
        this.loadSession(session.sessionId)
      }
    })
    this._listEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (item) {
        e.preventDefault()
        const idx = parseInt(item.dataset.idx!, 10)
        const session = agentSession.state.openSessions[idx]
        if (session) agentSession.removeOpenSession(session.sessionId)
      }
    })
    this._listEl.addEventListener('contextmenu', (e) => {
      const item = (e.target as HTMLElement).closest('.awfy-st-tab') as HTMLElement | null
      if (!item) return
      e.preventDefault()
      const idx = parseInt(item.dataset.idx!, 10)
      const session = agentSession.state.openSessions[idx]
      if (session) agentSession.removeOpenSession(session.sessionId)
    })
    this._listEl.addEventListener('scroll', () => this.updateFade(), { passive: true })
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

  private subscribeToEvents() {
    const keys: Array<keyof AgentSessionState> = [
      'openSessions',
      'activeSessionId',
      'streamingSessionIds',
      'label',
    ]
    this._unsubs.push(listen('agent-state-changed', ({ changedKeys }) => {
      if (keys.some((key) => changedKeys.includes(key))) this.scheduleUpdate()
    }))
  }

  private update() {
    if (!this._listEl) return
    const s = agentSession.state
    const open = s.openSessions

    // Hide the strip entirely when empty — a lone + button looks orphaned.
    this.style.display = open.length === 0 ? 'none' : ''
    if (open.length === 0) return

    const activeSessionId = s.activeSessionId
    const streamingSet = new Set(s.streamingSessionIds)

    if (activeSessionId && this._recency[this._recency.length - 1] !== activeSessionId) {
      this._recency = this._recency.filter((id) => id !== activeSessionId)
      this._recency.push(activeSessionId)
    }
    for (const { sessionId } of open) {
      if (sessionId !== activeSessionId && this._wasStreaming.has(sessionId) && !streamingSet.has(sessionId)) {
        this._unseen.add(sessionId)
      }
    }
    if (activeSessionId) this._unseen.delete(activeSessionId)
    this._wasStreaming = streamingSet

    const existing = Array.from(this._listEl.querySelectorAll('.awfy-st-tab')) as HTMLElement[]
    while (existing.length > open.length) {
      existing.pop()!.remove()
    }
    while (existing.length < open.length) {
      const item = document.createElement('div')
      item.className = 'awfy-st-tab'
      item.innerHTML = `<span class="awfy-st-dot"></span><span class="awfy-st-label"></span><span class="awfy-st-close" title="Close session">${CLOSE_SVG}</span>`
      this._listEl.appendChild(item)
      existing.push(item)
    }

    let activeItem: HTMLElement | null = null
    for (let i = 0; i < open.length; i++) {
      const item = existing[i]
      const sessionId = open[i].sessionId
      const isActive = sessionId === activeSessionId
      const labelText = isActive ? (s.label || 'New session') : open[i].label
      // `collapsed` belongs to fit(), which runs right after.
      item.classList.toggle('active', isActive)
      item.dataset.idx = String(i)
      item.title = labelText
      const dot = item.querySelector('.awfy-st-dot') as HTMLElement | null
      if (dot) {
        dot.className = 'awfy-st-dot'
          + (streamingSet.has(sessionId) ? ' streaming' : this._unseen.has(sessionId) ? ' unseen' : '')
      }
      const label = item.querySelector('.awfy-st-label') as HTMLElement | null
      if (label) label.textContent = labelText
      if (isActive) activeItem = item
    }

    this.fit()

    if (activeSessionId !== this._shownActiveId) {
      this._shownActiveId = activeSessionId
      activeItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  private scheduleFit() {
    if (this._fitPending) return
    this._fitPending = true
    requestAnimationFrame(() => {
      this._fitPending = false
      this.fit()
    })
  }

  /** Keep every title while there is room for it. When there isn't, the
   *  sessions viewed longest ago drop to a dot, one at a time, until the rest
   *  fit; past that the strip scrolls. */
  private fit() {
    if (!this._listEl) return
    const s = agentSession.state
    const ids = s.openSessions.map((o) => o.sessionId)
    const tabs = Array.from(this._listEl.querySelectorAll('.awfy-st-tab'))
    const avail = this._listEl.clientWidth

    // What each tab takes at its narrowest: its minimum, or less when the
    // whole title is shorter than that.
    const min = new Map<string, number>()
    let need = (ids.length - 1) * GAP
    tabs.forEach((tab, i) => {
      const title = Math.min(tab.querySelector('.awfy-st-label')!.scrollWidth + 1, LABEL_MAX)
      const width = Math.min(title + TAB_CHROME, ids[i] === s.activeSessionId ? ACTIVE_MIN : LABEL_MIN)
      min.set(ids[i], width)
      need += width
    })

    // Stable sort: never-viewed sessions go first, leftmost before the rest.
    const inactive = ids.filter((id) => id !== s.activeSessionId)
    inactive.sort((a, b) => this._recency.indexOf(a) - this._recency.indexOf(b))
    const collapsed = new Set<string>()
    for (const id of inactive) {
      if (need <= avail) break
      collapsed.add(id)
      need -= min.get(id)! - DOT_SIZE
    }

    tabs.forEach((tab, i) => tab.classList.toggle('collapsed', collapsed.has(ids[i])))
    this.updateFade()
  }

  /** Fade whichever edge has tabs scrolled out of view behind it. */
  private updateFade() {
    const list = this._listEl
    if (!list) return
    const hidden = list.scrollWidth - list.clientWidth
    list.classList.toggle('fade-start', list.scrollLeft > 1)
    list.classList.toggle('fade-end', list.scrollLeft < hidden - 1)
  }

  private loadSession(sessionId: string) {
    agentSession.loadSession(sessionId).catch(err => {
      this.dispatchEvent(new CustomEvent('session-error', {
        bubbles: true,
        detail: { message: err instanceof Error ? err.message : String(err) }
      }))
    })
  }

  private createSession() {
    agentSession.createSession().catch(err => {
      this.dispatchEvent(new CustomEvent('session-error', {
        bubbles: true,
        detail: { message: err instanceof Error ? err.message : String(err) }
      }))
    })
  }
}
