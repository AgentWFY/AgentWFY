/* eslint-disable import/no-unresolved */

const CHAT_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`

const TASKS_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="5 3 19 12 5 21 5 3"/>
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
  :host(.platform-darwin) .items {
    padding-top: 28px;
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
`

export class TlActivityBar extends HTMLElement {
  private _activePanel: string | null = null
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

  connectedCallback() {
    if (navigator.platform.includes('Mac')) {
      this.classList.add('platform-darwin')
    }
    this.render()
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="items">
        <div class="item" data-panel="agent-chat" title="Agent Chat">
          ${CHAT_ICON}
        </div>
        <div class="item" data-panel="tasks" title="Tasks">
          ${TASKS_ICON}
        </div>
      </div>
    `
    this.attachListeners()
    this.updateActiveState()
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
}
