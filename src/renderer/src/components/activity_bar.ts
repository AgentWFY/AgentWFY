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
  .running-indicator {
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    margin-bottom: 10px;
    font-size: 11px;
    font-weight: 600;
    color: #4caf50;
    background: rgba(76, 175, 80, 0.1);
    animation: orb-pulse 2s ease-in-out infinite;
  }
  .running-indicator.visible {
    display: flex;
  }
  @keyframes orb-pulse {
    0%, 100% { box-shadow: 0 0 4px rgba(76, 175, 80, 0.3); }
    50% { box-shadow: 0 0 12px rgba(76, 175, 80, 0.5); }
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
      <div class="running-indicator" id="running-indicator" title="Running agents">0</div>
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
    const indicator = this.shadow.querySelector('#running-indicator')
    if (!indicator) return
    if (this._agentCount > 0) {
      indicator.textContent = String(this._agentCount)
      indicator.classList.add('visible')
    } else {
      indicator.classList.remove('visible')
    }
  }
}
