import { agentSessionStore } from '../stores/agent-session-store.js'

const STYLES = `
  awfy-provider-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 16px;
    flex: 1;
    justify-content: flex-start;
    overflow-y: auto;
    min-height: 0;
  }
  .provider-card {
    display: flex;
    flex-direction: column;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }
  .provider-card:hover {
    background: var(--color-item-hover);
  }
  .provider-card.selected {
    border-color: var(--color-accent);
  }
  .provider-card-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text4);
  }
  .provider-card-status {
    font-size: 11px;
    color: var(--color-text2);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .provider-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    min-height: 22px;
  }
  .provider-card-settings-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 3px 6px;
    margin: -3px -6px;
    color: var(--color-text2);
    font-size: 11px;
    line-height: 1;
    border-radius: 3px;
  }
  .provider-card-settings-btn:hover {
    color: var(--color-text4);
    background: var(--color-bg3);
  }
  .provider-card-settings-btn svg {
    flex-shrink: 0;
  }
  .default-badge {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--color-accent);
    padding: 2px 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    margin-left: auto;
  }
  .set-default-btn {
    font-size: 10px;
    color: var(--color-text2);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    cursor: pointer;
    padding: 2px 8px;
    margin-left: auto;
    opacity: 0;
    transition: opacity var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }
  .provider-card:hover .set-default-btn {
    opacity: 1;
  }
  .set-default-btn:hover {
    color: var(--color-accent);
    border-color: var(--color-accent);
  }
  .browse-providers-link {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 12px;
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    background: none;
    font-family: inherit;
    font-size: 12px;
    color: var(--color-text2);
    transition: border-color var(--transition-fast), color var(--transition-fast);
  }
  .browse-providers-link:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
`

const GEAR_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
const PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>'

export class TlProviderGrid extends HTMLElement {
  private _styleEl: HTMLStyleElement | null = null
  private _unsubs: (() => void)[] = []
  private _renderPending = false

  connectedCallback() {
    this._styleEl = document.createElement('style')
    this._styleEl.textContent = STYLES
    this.appendChild(this._styleEl)

    this.addEventListener('mousedown', this.onMouseDown)
    this.subscribeToStore()
    this.render()
  }

  disconnectedCallback() {
    this.removeEventListener('mousedown', this.onMouseDown)
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
  }

  private scheduleRender() {
    if (this._renderPending) return
    this._renderPending = true
    requestAnimationFrame(() => {
      this._renderPending = false
      this.render()
    })
  }

  private subscribeToStore() {
    this._unsubs.push(agentSessionStore.select(s => s.providerList, () => this.scheduleRender()))
    this._unsubs.push(agentSessionStore.select(s => s.selectedProviderId, () => this.scheduleRender()))
    this._unsubs.push(agentSessionStore.select(s => s.defaultProviderId, () => this.scheduleRender()))
    this._unsubs.push(agentSessionStore.select(s => s.providerStatusLines, () => this.scheduleRender()))
  }

  private onMouseDown = (e: Event) => {
    const me = e as MouseEvent
    const target = me.target as HTMLElement

    const browseBtn = target.closest('[data-action="browse-providers"]') as HTMLElement | null
    if (browseBtn) {
      me.preventDefault()
      window.ipc?.tabs.openTab({ viewName: 'system.plugins', params: { tag: 'providers', tab: 'browse-plugins' } })
      return
    }

    const settingsBtn = target.closest('.provider-card-settings-btn[data-settings-view]') as HTMLElement | null
    if (settingsBtn) {
      me.preventDefault()
      me.stopPropagation()
      this.openSettingsView(settingsBtn.dataset.settingsView!)
      return
    }

    const setDefaultBtn = target.closest('.set-default-btn[data-provider-id]') as HTMLElement | null
    if (setDefaultBtn) {
      me.preventDefault()
      me.stopPropagation()
      this.handleSetDefault(setDefaultBtn.dataset.providerId!)
      return
    }

    const card = target.closest('.provider-card[data-provider-id]') as HTMLElement | null
    if (card) {
      me.preventDefault()
      agentSessionStore.selectProvider(card.dataset.providerId!)
    }
  }

  private render() {
    const s = agentSessionStore.state
    // Keep the style element, rebuild the rest
    const frag = document.createDocumentFragment()
    if (this._styleEl) frag.appendChild(this._styleEl)

    if (s.providerList.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'text-align:center;color:var(--color-text2);font-size:13px;'
      empty.textContent = 'No providers configured'
      frag.appendChild(empty)
    } else {
      for (const p of s.providerList) {
        const isSelected = p.id === s.selectedProviderId
        const isDefault = p.id === s.defaultProviderId
        const statusLine = s.providerStatusLines.get(p.id) || ''

        const card = document.createElement('div')
        card.className = 'provider-card' + (isSelected ? ' selected' : '')
        card.dataset.providerId = p.id

        const nameEl = document.createElement('div')
        nameEl.className = 'provider-card-name'
        nameEl.textContent = p.name
        card.appendChild(nameEl)

        const statusEl = document.createElement('div')
        statusEl.className = 'provider-card-status'
        statusEl.textContent = statusLine
        card.appendChild(statusEl)

        const footer = document.createElement('div')
        footer.className = 'provider-card-footer'

        if (p.settingsView) {
          const btn = document.createElement('button')
          btn.className = 'provider-card-settings-btn'
          btn.dataset.settingsView = p.settingsView
          btn.innerHTML = `${GEAR_SVG} Settings`
          footer.appendChild(btn)
        }

        if (isDefault) {
          const badge = document.createElement('span')
          badge.className = 'default-badge'
          badge.textContent = 'default'
          footer.appendChild(badge)
        } else {
          const btn = document.createElement('button')
          btn.className = 'set-default-btn'
          btn.dataset.providerId = p.id
          btn.textContent = 'set default'
          footer.appendChild(btn)
        }

        card.appendChild(footer)
        frag.appendChild(card)
      }

      const browseBtn = document.createElement('button')
      browseBtn.className = 'browse-providers-link'
      browseBtn.dataset.action = 'browse-providers'
      browseBtn.innerHTML = `${PLUS_SVG}Add provider`
      frag.appendChild(browseBtn)
    }

    this.replaceChildren(frag)
  }

  private openSettingsView(viewName: string) {
    window.ipc?.tabs.openTab({ viewName }).catch(e => {
      console.error('[provider-grid] failed to open settings view', e)
    })
  }

  private handleSetDefault(providerId: string) {
    agentSessionStore.setDefaultProvider(providerId).catch(e => {
      this.dispatchEvent(new CustomEvent('provider-error', {
        bubbles: true,
        detail: { message: e instanceof Error ? e.message : String(e) }
      }))
    })
  }
}
