import { getSessionManager } from 'app/agent/session_manager'
import { getTaskRunner } from 'app/tasks/task_runner'

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
  .data-dir {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  connectedCallback() {
    this.render()
    this.subscribeToManager()
    this.subscribeToTaskRunner()
    this.loadDataDir()
  }

  disconnectedCallback() {
    this.managerUnsub?.()
    this.managerUnsub = null
    this.taskRunnerUnsub?.()
    this.taskRunnerUnsub = null
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
        <span class="data-dir" id="data-dir"></span>
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
        ? labels.map(l => `<div class="tooltip-session">${this.escapeHtml(l)}</div>`).join('')
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
        ? labels.map(l => `<div class="tooltip-session">${this.escapeHtml(l)}</div>`).join('')
        : ''
      tooltip.innerHTML = `<div class="tooltip-title">Running tasks</div>${listHtml}`
    } else {
      indicator.classList.remove('visible')
    }
  }

  private async loadDataDir() {
    const dirEl = this.shadow.querySelector('#data-dir')
    if (!dirEl) return
    try {
      const dataDir = await window.ipc?.store.get('dataDir') as string
      if (dataDir) {
        dirEl.textContent = this.shortenPath(dataDir)
        dirEl.setAttribute('title', dataDir)
      }
    } catch {
      // ignore — store not available
    }
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

  private escapeHtml(text: string): string {
    const el = document.createElement('span')
    el.textContent = text
    return el.innerHTML
  }
}
