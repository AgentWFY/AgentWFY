import { getSessionManager } from 'app/agent/session_manager'

const CHAT_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    width: var(--activity-bar-width);
    flex-shrink: 0;
    background: var(--color-activity-bar-bg);
    border-right: 1px solid var(--color-border);
    user-select: none;
  }
  .items {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 4px;
    gap: 2px;
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-activity-bar-fg);
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .item:hover {
    color: var(--color-activity-bar-fg-active);
    background: var(--color-item-hover);
  }
  .item.active {
    color: var(--color-activity-bar-fg-active);
  }
  .item.active::before {
    content: '';
    position: absolute;
    left: -4px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--color-accent);
  }
  .running-wrapper {
    display: none;
    position: relative;
    margin-bottom: 10px;
  }
  .running-wrapper.visible {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .running-indicator {
    position: relative;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: default;
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa, #6366f1);
    background-size: 300% 300%;
    animation: gradient-rotate 3s ease-in-out infinite;
    box-shadow: 0 0 8px rgba(99, 102, 241, 0.4);
  }
  @keyframes gradient-rotate {
    0% { background-position: 0% 50%; box-shadow: 0 0 8px rgba(99, 102, 241, 0.4); }
    50% { background-position: 100% 50%; box-shadow: 0 0 14px rgba(139, 92, 246, 0.5); }
    100% { background-position: 0% 50%; box-shadow: 0 0 8px rgba(99, 102, 241, 0.4); }
  }
  .running-tooltip {
    display: none;
    position: absolute;
    left: calc(100% + 8px);
    bottom: 0;
    min-width: 140px;
    max-width: 220px;
    background: var(--color-bg-elevated, #1e1e2e);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 8px 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    z-index: 1000;
    pointer-events: none;
  }
  .running-wrapper:hover .running-tooltip {
    display: block;
  }
  .tooltip-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-fg, #cdd6f4);
    margin-bottom: 4px;
  }
  .tooltip-session {
    font-size: 10px;
    color: var(--color-fg-muted, #a6adc8);
    padding: 2px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

export class TlActivityBar extends HTMLElement {
  private _activePanel: string | null = null
  private _agentCount = 0
  private shadow: ShadowRoot
  private managerUnsub: (() => void) | null = null

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  get activePanel(): string | null { return this._activePanel }
  set activePanel(val: string | null) {
    this._activePanel = val
    this.updateActiveState()
  }

  connectedCallback() {
    this.render()
    this.subscribeToManager()
  }

  disconnectedCallback() {
    this.managerUnsub?.()
    this.managerUnsub = null
  }

  private subscribeToManager() {
    const mgr = getSessionManager()
    if (!mgr) {
      // Manager not yet initialized — poll until available
      const interval = setInterval(() => {
        const m = getSessionManager()
        if (m) {
          clearInterval(interval)
          this.managerUnsub = m.subscribe(() => this.syncAgentCount())
          this.syncAgentCount()
        }
      }, 500)
      return
    }
    this.managerUnsub = mgr.subscribe(() => this.syncAgentCount())
    this.syncAgentCount()
  }

  private syncAgentCount() {
    const mgr = getSessionManager()
    const count = mgr ? mgr.streamingSessionsCount : 0
    if (count !== this._agentCount) {
      this._agentCount = count
      this.updateBadge()
    }
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="items">
        <div class="item" data-panel="agent-chat" title="Agent Chat">
          ${CHAT_ICON}
        </div>
      </div>
      <div class="running-wrapper" id="running-wrapper">
        <div class="running-indicator" id="running-indicator">0</div>
        <div class="running-tooltip" id="running-tooltip">
          <div class="tooltip-title">Running agents</div>
        </div>
      </div>
    `
    this.attachListeners()
    this.updateActiveState()
    this.updateBadge()
  }

  private attachListeners() {
    const items = this.shadow.querySelectorAll('.item[data-panel]')
    items.forEach(el => {
      el.addEventListener('click', () => {
        const panel = (el as HTMLElement).dataset.panel!
        this.dispatchEvent(new CustomEvent('panel-toggle', {
          detail: { panel },
          bubbles: true,
          composed: true,
        }))
      })
    })
  }

  private updateActiveState() {
    const items = this.shadow.querySelectorAll('.item[data-panel]')
    items.forEach(el => {
      const panel = (el as HTMLElement).dataset.panel
      el.classList.toggle('active', panel === this._activePanel)
    })
  }

  private updateBadge() {
    const wrapper = this.shadow.querySelector('#running-wrapper')
    const indicator = this.shadow.querySelector('#running-indicator')
    const tooltip = this.shadow.querySelector('#running-tooltip')
    if (!wrapper || !indicator || !tooltip) return

    if (this._agentCount > 0) {
      indicator.textContent = String(this._agentCount)
      wrapper.classList.add('visible')

      const mgr = getSessionManager()
      const labels = mgr ? mgr.streamingSessionLabels : []
      const sessionListHtml = labels.length > 0
        ? labels.map(l => `<div class="tooltip-session">${this.escapeHtml(l)}</div>`).join('')
        : ''
      tooltip.innerHTML = `<div class="tooltip-title">Running agents</div>${sessionListHtml}`
    } else {
      wrapper.classList.remove('visible')
    }
  }

  private escapeHtml(text: string): string {
    const el = document.createElement('span')
    el.textContent = text
    return el.innerHTML
  }
}
