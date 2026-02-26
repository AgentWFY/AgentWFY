const CHAT_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
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
  .badge {
    position: absolute;
    top: 4px;
    right: 3px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    background: var(--color-badge-bg);
    color: var(--color-badge-fg);
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    line-height: 1;
    pointer-events: none;
    box-sizing: border-box;
  }
  .badge.hidden {
    display: none;
  }
`

export class TlActivityBar extends HTMLElement {
  private _activePanel: string | null = null
  private _agentCount = 0
  private shadow: ShadowRoot

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  get activePanel(): string | null { return this._activePanel }
  set activePanel(val: string | null) {
    this._activePanel = val
    this.updateActiveState()
  }

  get agentCount(): number { return this._agentCount }
  set agentCount(val: number) {
    this._agentCount = val
    this.updateBadge()
  }

  connectedCallback() {
    this.render()
    window.addEventListener('agentwfy:agent-count', this.onAgentCount)
  }

  disconnectedCallback() {
    window.removeEventListener('agentwfy:agent-count', this.onAgentCount)
  }

  private onAgentCount = (e: Event) => {
    const detail = (e as CustomEvent<{ count: number }>).detail
    this.agentCount = detail.count
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="items">
        <div class="item" data-panel="agent-chat" title="Agent Chat">
          ${CHAT_ICON}
          <span class="badge hidden" id="agent-badge">0</span>
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
    const badge = this.shadow.querySelector('#agent-badge')
    if (!badge) return
    if (this._agentCount > 0) {
      badge.textContent = String(this._agentCount)
      badge.classList.remove('hidden')
    } else {
      badge.classList.add('hidden')
    }
  }
}
