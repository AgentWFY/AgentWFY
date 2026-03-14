import { getSessionManager } from '../agent/session_manager.js'
import { getTaskRunner } from '../tasks/task_runner.js'
import { escapeHtml } from './chat_utils.js'

const STYLES = `
  :host {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: var(--status-line-height, 24px);
    flex-shrink: 0;
    background: var(--color-border);
    border-top: 1px solid var(--color-border);
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
    cursor: default;
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
    cursor: default;
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
  .task-tooltip {
    display: none;
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    min-width: 140px;
    max-width: 220px;
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    padding: 8px 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    z-index: 1000;
    pointer-events: none;
  }
  .task-indicator:hover .task-tooltip {
    display: block;
  }
  .agent-tooltip {
    display: none;
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    min-width: 140px;
    max-width: 220px;
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    padding: 8px 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    z-index: 1000;
    pointer-events: none;
  }
  .agent-indicator:hover .agent-tooltip {
    display: block;
  }
  .tooltip-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text3);
    margin-bottom: 4px;
  }
  .tooltip-session {
    font-size: 10px;
    color: var(--color-text1);
    padding: 2px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

export class TlStatusLine extends HTMLElement {
  private shadow: ShadowRoot
  private _agentCount = 0
  private _taskCount = 0
  private managerUnsub: (() => void) | null = null
  private taskRunnerUnsub: (() => void) | null = null

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  private flashTimeout: ReturnType<typeof setTimeout> | null = null

  private onBackupChanged = (event: Event) => {
    const detail = (event as CustomEvent)?.detail
    if (detail?.version != null) {
      this.showBackupFlash(`Backed up v${detail.version}`)
    } else if (detail?.skipped) {
      this.showBackupFlash('No changes to back up')
    } else if (detail?.restored != null) {
      this.showBackupFlash(`Restored v${detail.restored}`)
    } else {
      this.loadBackupInfo()
    }
  }

  connectedCallback() {
    this.render()
    this.bindBackupClick()
    this.subscribeToManager()
    this.subscribeToTaskRunner()
    this.loadPortInfo()
    this.loadDataDir()
    this.loadBackupInfo()
    window.addEventListener('agentwfy:backup-changed', this.onBackupChanged)
  }

  disconnectedCallback() {
    this.managerUnsub?.()
    this.managerUnsub = null
    this.taskRunnerUnsub?.()
    this.taskRunnerUnsub = null
    window.removeEventListener('agentwfy:backup-changed', this.onBackupChanged)
    if (this.flashTimeout) clearTimeout(this.flashTimeout)
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="left">
        <div class="agent-indicator" id="agent-indicator">
          <div class="agent-dot"></div>
          <span class="agent-label" id="agent-label"></span>
          <div class="agent-tooltip" id="agent-tooltip">
            <div class="tooltip-title">Running agents</div>
          </div>
        </div>
        <div class="task-indicator" id="task-indicator">
          <div class="task-dot"></div>
          <span class="task-label" id="task-label"></span>
          <div class="task-tooltip" id="task-tooltip">
            <div class="tooltip-title">Running tasks</div>
          </div>
        </div>
      </div>
      <div class="right">
        <button class="port-info" id="port-info" type="button"></button>
        <span class="separator" id="port-sep"></span>
        <button class="backup-info" id="backup-info" type="button"></button>
        <span class="separator" id="backup-sep"></span>
        <button class="data-dir" id="data-dir" type="button"></button>
      </div>
    `
  }

  private subscribeToManager() {
    const mgr = getSessionManager()
    if (!mgr) {
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
      this.updateAgentIndicator()
    }
  }

  private updateAgentIndicator() {
    const indicator = this.shadow.querySelector('#agent-indicator')
    const label = this.shadow.querySelector('#agent-label')
    const tooltip = this.shadow.querySelector('#agent-tooltip')
    if (!indicator || !label || !tooltip) return

    if (this._agentCount > 0) {
      const suffix = this._agentCount === 1 ? 'agent running' : 'agents running'
      label.textContent = `${this._agentCount} ${suffix}`
      indicator.classList.add('visible')

      const mgr = getSessionManager()
      const labels = mgr ? mgr.streamingSessionLabels : []
      const sessionListHtml = labels.length > 0
        ? labels.map(l => `<div class="tooltip-session">${escapeHtml(l)}</div>`).join('')
        : ''
      tooltip.innerHTML = `<div class="tooltip-title">Running agents</div>${sessionListHtml}`
    } else {
      indicator.classList.remove('visible')
    }
  }

  private subscribeToTaskRunner() {
    const runner = getTaskRunner()
    if (!runner) {
      const interval = setInterval(() => {
        const r = getTaskRunner()
        if (r) {
          clearInterval(interval)
          this.taskRunnerUnsub = r.subscribe(() => this.syncTaskCount())
          this.syncTaskCount()
        }
      }, 500)
      return
    }
    this.taskRunnerUnsub = runner.subscribe(() => this.syncTaskCount())
    this.syncTaskCount()
  }

  private syncTaskCount() {
    const runner = getTaskRunner()
    const count = runner ? runner.runningCount : 0
    if (count !== this._taskCount) {
      this._taskCount = count
      this.updateTaskIndicator()
    }
  }

  private updateTaskIndicator() {
    const indicator = this.shadow.querySelector('#task-indicator')
    const label = this.shadow.querySelector('#task-label')
    const tooltip = this.shadow.querySelector('#task-tooltip')
    if (!indicator || !label || !tooltip) return

    if (this._taskCount > 0) {
      const suffix = this._taskCount === 1 ? 'task running' : 'tasks running'
      label.textContent = `${this._taskCount} ${suffix}`
      indicator.classList.add('visible')

      const runner = getTaskRunner()
      const labels = runner ? runner.runningLabels : []
      const listHtml = labels.length > 0
        ? labels.map(l => `<div class="tooltip-session">${escapeHtml(l)}</div>`).join('')
        : ''
      tooltip.innerHTML = `<div class="tooltip-title">Running tasks</div>${listHtml}`
    } else {
      indicator.classList.remove('visible')
    }
  }

  private async loadPortInfo() {
    const portEl = this.shadow.querySelector('#port-info') as HTMLButtonElement | null
    const sepEl = this.shadow.querySelector('#port-sep') as HTMLSpanElement | null
    if (!portEl || !sepEl) return
    portEl.addEventListener('click', () => {
      window.ipc?.commandPalette?.show({ screen: 'agent-settings' })
    })
    try {
      const port = await window.ipc?.getHttpApiPort()
      if (port != null) {
        portEl.innerHTML = `<svg class="port-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/><path d="M5 11A4.5 4.5 0 0 1 5 5"/><path d="M11 5a4.5 4.5 0 0 1 0 6"/><path d="M3 13A7.5 7.5 0 0 1 3 3"/><path d="M13 3a7.5 7.5 0 0 1 0 10"/></svg><span class="port-number">:${port}</span>`
        portEl.setAttribute('title', `HTTP API on port ${port}`)
        sepEl.textContent = '|'
      }
    } catch {
      // ignore — IPC not available
    }
  }

  private async loadDataDir() {
    const dirEl = this.shadow.querySelector('#data-dir') as HTMLButtonElement | null
    if (!dirEl) return
    dirEl.addEventListener('click', () => {
      window.ipc?.commandPalette?.showFiltered('Agent')
    })
    try {
      const agentRoot = await window.ipc?.getAgentRoot()
      if (agentRoot) {
        dirEl.textContent = this.shortenPath(agentRoot)
        dirEl.setAttribute('title', agentRoot)
      }
    } catch {
      // ignore — IPC not available
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

  private showBackupFlash(message: string) {
    const infoEl = this.shadow.querySelector('#backup-info') as HTMLButtonElement | null
    if (!infoEl) return
    if (this.flashTimeout) clearTimeout(this.flashTimeout)
    infoEl.textContent = message
    this.flashTimeout = setTimeout(() => {
      this.flashTimeout = null
      this.loadBackupInfo()
    }, 2000)
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
