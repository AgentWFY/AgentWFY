const STYLES = `
  :host {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: var(--status-line-height, 24px);
    flex-shrink: 0;
    background: var(--color-status-line-bg);
    padding: 0 10px;
    box-sizing: border-box;
    font-family: var(--font-family);
    font-size: 12px;
    color: var(--color-text1);
    user-select: none;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .right {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .agent-indicator {
    display: none;
    align-items: center;
    gap: 5px;
    position: relative;
    cursor: pointer;
  }
  .agent-indicator.visible {
    display: flex;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-green-fg);
    animation: dot-pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes dot-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 3px color-mix(in srgb, var(--color-green-fg) 40%, transparent); }
    50% { opacity: 0.5; box-shadow: 0 0 6px color-mix(in srgb, var(--color-green-fg) 50%, transparent); }
  }
  .agent-label {
    white-space: nowrap;
  }
  .task-indicator {
    display: none;
    align-items: center;
    gap: 5px;
    position: relative;
    cursor: pointer;
  }
  .task-indicator.visible {
    display: flex;
  }
  .task-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: dot-pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }
  .task-label {
    white-space: nowrap;
  }
  .notification {
    display: none;
    align-items: center;
    font-size: 11px;
    color: var(--color-text3);
    white-space: nowrap;
    background: var(--color-surface);
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 4px;
  }
  .notification.visible {
    display: flex;
  }
  .agent-indicator:hover,
  .task-indicator:hover {
    color: var(--color-text3);
  }
  .port-info {
    font-size: 11px;
    color: var(--color-text2);
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0 4px;
    border-radius: 2px;
    line-height: inherit;
    font-family: inherit;
    user-select: none;
  }
  .port-info:hover {
    background: var(--color-item-hover);
    color: var(--color-text3);
  }
  .port-info .port-number {
    display: none;
    font-family: var(--font-mono);
  }
  .port-info:hover .port-number {
    display: inline;
  }
  .port-info .port-icon {
    display: inline-block;
    width: 14px;
    height: 14px;
    vertical-align: -2px;
    color: var(--color-text2);
  }
  .port-info:hover .port-icon {
    display: none;
  }
  .data-dir {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0 4px;
    border-radius: 2px;
    line-height: inherit;
  }
  .data-dir:hover {
    background: var(--color-item-hover);
    color: var(--color-text3);
  }
  .backup-info {
    font-size: 11px;
    color: var(--color-text2);
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0 4px;
    border-radius: 2px;
    line-height: inherit;
    font-family: inherit;
    user-select: none;
  }
  .backup-info:hover {
    background: var(--color-item-hover);
    color: var(--color-text3);
  }
  .separator {
    color: var(--color-text1);
    opacity: 0.3;
    padding: 0 2px;
  }
`

import { agentSessionStore } from '../stores/agent-session-store.js'

export class TlStatusLine extends HTMLElement {
  private shadow: ShadowRoot
  private _agentCount = 0
  private _storeUnsub: (() => void) | null = null

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  private notificationTimeout: ReturnType<typeof setTimeout> | null = null

  private onPluginChanged = (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.message) {
      this.showNotification(detail.message)
    }
  }

  private onBackupChanged = (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.version != null) {
      this.showNotification(`Backed up v${detail.version}`)
    } else if (detail?.skipped) {
      this.showNotification('No changes to back up')
    } else if (detail?.restored != null) {
      this.showNotification(`Restored v${detail.restored}`)
    }
    if (detail?.version != null || detail?.skipped || detail?.restored != null) {
      // Also refresh the backup version display after flash
      setTimeout(() => this.loadBackupInfo(), 3000)
    } else {
      this.loadBackupInfo()
    }
  }

  private onAgentSwitched = () => {
    this.loadPortInfo()
    this.loadDataDir()
    this.loadBackupInfo()
  }

  connectedCallback() {
    this.render()
    this.bindBackupClick()
    this.bindIndicatorClicks()
    this.subscribeToSnapshots()
    this.loadPortInfo()
    this.loadDataDir()
    this.loadBackupInfo()
    this._clicksBound = true
    window.addEventListener('agentwfy:backup-changed', this.onBackupChanged)
    window.addEventListener('agentwfy:plugin-changed', this.onPluginChanged)
    window.addEventListener('agentwfy:agent-switched', this.onAgentSwitched)
  }

  disconnectedCallback() {
    this._storeUnsub?.()
    this._storeUnsub = null
    window.removeEventListener('agentwfy:backup-changed', this.onBackupChanged)
    window.removeEventListener('agentwfy:plugin-changed', this.onPluginChanged)
    window.removeEventListener('agentwfy:agent-switched', this.onAgentSwitched)
    if (this.notificationTimeout) clearTimeout(this.notificationTimeout)
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="left">
        <div class="agent-indicator" id="agent-indicator">
          <div class="agent-dot"></div>
          <span class="agent-label" id="agent-label"></span>
        </div>
        <div class="task-indicator" id="task-indicator">
          <div class="task-dot"></div>
          <span class="task-label" id="task-label"></span>
        </div>
      </div>
      <div class="right">
        <span class="notification" id="notification"></span>
        <button class="port-info" id="port-info" type="button"></button>
        <span class="separator" id="port-sep"></span>
        <button class="backup-info" id="backup-info" type="button"></button>
        <span class="separator" id="backup-sep"></span>
        <button class="data-dir" id="data-dir" type="button"></button>
      </div>
    `
  }

  private subscribeToSnapshots() {
    this._storeUnsub = agentSessionStore.select(
      s => s.streamingSessionsCount,
      (count) => {
        this._agentCount = count
        this.updateAgentIndicator()
      }
    )
  }

  private updateAgentIndicator() {
    const indicator = this.shadow.querySelector('#agent-indicator')
    const label = this.shadow.querySelector('#agent-label')
    if (!indicator || !label) return

    if (this._agentCount > 0) {
      const suffix = this._agentCount === 1 ? 'session running' : 'sessions running'
      label.textContent = `${this._agentCount} ${suffix}`
      indicator.classList.add('visible')
    } else {
      indicator.classList.remove('visible')
    }
  }

  private _clicksBound = false

  private async loadPortInfo() {
    const portEl = this.shadow.querySelector('#port-info') as HTMLButtonElement | null
    const sepEl = this.shadow.querySelector('#port-sep') as HTMLSpanElement | null
    if (!portEl || !sepEl) return
    if (!this._clicksBound) {
      portEl.addEventListener('click', () => {
        window.ipc?.commandPalette?.show({ screen: 'agent-settings' })
      })
    }
    try {
      const port = await window.ipc?.getHttpApiPort()
      if (port != null) {
        portEl.innerHTML = `<svg class="port-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/><path d="M5 11A4.5 4.5 0 0 1 5 5"/><path d="M11 5a4.5 4.5 0 0 1 0 6"/><path d="M3 13A7.5 7.5 0 0 1 3 3"/><path d="M13 3a7.5 7.5 0 0 1 0 10"/></svg><span class="port-number">:${port}</span>`
        portEl.setAttribute('title', `HTTP API on port ${port}`)
        sepEl.textContent = '|'
      } else {
        portEl.innerHTML = ''
        portEl.removeAttribute('title')
        sepEl.textContent = ''
      }
    } catch {
      // ignore — IPC not available
    }
  }

  private async loadDataDir() {
    const dirEl = this.shadow.querySelector('#data-dir') as HTMLButtonElement | null
    if (!dirEl) return
    if (!this._clicksBound) {
      dirEl.addEventListener('click', () => {
        window.ipc?.commandPalette?.showFiltered('Agent')
      })
    }
    try {
      const agentRoot = await window.ipc?.getAgentRoot()
      if (agentRoot) {
        dirEl.textContent = this.shortenPath(agentRoot)
        dirEl.setAttribute('title', agentRoot)
      } else {
        dirEl.textContent = ''
        dirEl.removeAttribute('title')
      }
    } catch {
      // ignore — IPC not available
    }
  }

  private bindIndicatorClicks() {
    for (const [id, panel] of [['agent-indicator', 'agent-chat'], ['task-indicator', 'tasks']]) {
      this.shadow.querySelector(`#${id}`)?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('agentwfy:open-sidebar-panel', { detail: { panel } }))
      })
    }
  }

  private bindBackupClick() {
    const infoEl = this.shadow.querySelector('#backup-info') as HTMLButtonElement | null
    if (!infoEl) return
    infoEl.addEventListener('click', () => {
      window.ipc?.commandPalette?.showFiltered('Restore Agent Database')
    })
  }

  private async loadBackupInfo() {
    const infoEl = this.shadow.querySelector('#backup-info') as HTMLButtonElement | null
    const sepEl = this.shadow.querySelector('#backup-sep') as HTMLSpanElement | null
    if (!infoEl || !sepEl) return

    try {
      const status = await window.ipc?.getBackupStatus()
      if (!status || !status.latestBackup) {
        // Initial backup hasn't finished yet — leave empty, will update via event
        return
      }

      let text: string
      let title: string
      if (status.currentVersion != null) {
        const suffix = status.modified ? ' *' : ''
        text = `v${status.currentVersion}${suffix}`
        title = `Agent version v${status.currentVersion}${status.modified ? ' (modified)' : ''}`
      } else {
        text = `v${status.latestBackup.version} *`
        title = `Modified since v${status.latestBackup.version}`
      }

      // Only update DOM if content changed — avoids stealing focus
      if (infoEl.textContent !== text) infoEl.textContent = text
      if (infoEl.getAttribute('title') !== title) infoEl.setAttribute('title', title)
      if (sepEl.textContent !== '|') sepEl.textContent = '|'
    } catch {
      // ignore — IPC not available
    }
  }

  private showNotification(message: string) {
    const el = this.shadow.querySelector('#notification')
    if (!el) return
    if (this.notificationTimeout) clearTimeout(this.notificationTimeout)
    el.textContent = message
    el.classList.add('visible')
    this.notificationTimeout = setTimeout(() => {
      this.notificationTimeout = null
      el.classList.remove('visible')
    }, 3000)
  }

  private shortenPath(fullPath: string): string {
    const home = this.getHomePath(fullPath)
    if (home && fullPath.startsWith(home)) {
      return '~' + fullPath.slice(home.length)
    }
    return fullPath
  }

  private getHomePath(fullPath: string): string | null {
    // Try to detect home dir from path pattern
    const match = fullPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)
    return match ? match[1] : null
  }

}
