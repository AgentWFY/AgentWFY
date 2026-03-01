/* eslint-disable import/no-unresolved */
import { getTaskRunner } from 'app/tasks/task_runner'
import type { TaskRun, TaskLogHistoryItem } from 'app/tasks/task_runner'

interface TaskItem {
  id: number
  name: string
  timeout_ms: number | null
}

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family: var(--font-family);
    color: var(--color-text3);
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text2);
    flex-shrink: 0;
  }
  .scroll-area {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 10px;
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text1);
    padding: 10px 4px 4px;
  }
  .empty {
    font-size: 12px;
    color: var(--color-text1);
    padding: 6px 4px;
    font-style: italic;
  }
  .task-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-radius: var(--radius-sm, 4px);
    cursor: default;
    font-size: 12px;
    gap: 6px;
  }
  .task-item:hover {
    background: var(--color-item-hover);
  }
  .task-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn {
    padding: 2px 8px;
    font-size: 11px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg2);
    color: var(--color-text3);
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn:hover {
    background: var(--color-item-hover);
  }
  .btn-stop {
    border-color: var(--color-red-fg, #e55);
    color: var(--color-red-fg, #e55);
  }
  .run-entry {
    padding: 6px 8px;
    border-radius: var(--radius-sm, 4px);
    font-size: 12px;
    margin-bottom: 2px;
  }
  .run-entry:hover {
    background: var(--color-item-hover);
  }
  .run-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    cursor: pointer;
  }
  .run-status {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .run-status.running {
    background: var(--color-green-fg);
    animation: pulse 2s ease-in-out infinite;
  }
  .run-status.completed { background: var(--color-green-fg); }
  .run-status.failed { background: var(--color-red-fg, #e55); }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .run-info {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-time {
    font-size: 10px;
    color: var(--color-text1);
    flex-shrink: 0;
  }
  .run-logs {
    display: none;
    margin-top: 4px;
    padding: 4px 6px;
    background: var(--color-bg1);
    border-radius: var(--radius-sm, 4px);
    font-family: var(--font-mono);
    font-size: 11px;
    max-height: 160px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text2);
  }
  .run-logs.open { display: block; }
  .run-error {
    color: var(--color-red-fg, #e55);
  }
  .log-entry {
    padding: 1px 0;
  }
  .log-entry.warn { color: var(--color-yellow-fg, #cc8); }
  .log-entry.error { color: var(--color-red-fg, #e55); }
  .history-item {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: var(--radius-sm, 4px);
    font-size: 11px;
    gap: 6px;
    cursor: pointer;
    color: var(--color-text2);
  }
  .history-item:hover {
    background: var(--color-item-hover);
  }
  .history-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-status {
    font-size: 10px;
    flex-shrink: 0;
  }
  .history-date {
    font-size: 10px;
    color: var(--color-text1);
    flex-shrink: 0;
  }
  .history-detail {
    display: none;
    margin: 2px 8px 6px;
    padding: 4px 6px;
    background: var(--color-bg1);
    border-radius: var(--radius-sm, 4px);
    font-family: var(--font-mono);
    font-size: 11px;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text2);
  }
  .history-detail.open { display: block; }
`

function escapeHtml(text: string): string {
  const el = document.createElement('span')
  el.textContent = text
  return el.innerHTML
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export class TlTaskPanel extends HTMLElement {
  private shadow: ShadowRoot
  private tasks: TaskItem[] = []
  private logHistory: TaskLogHistoryItem[] = []
  private expandedRunIds = new Set<string>()
  private expandedHistoryFiles = new Set<string>()
  private historyDetails = new Map<string, string>()
  private runnerUnsub: (() => void) | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  connectedCallback() {
    this.render()
    this.subscribeRunner()
    this.loadTasks()
    this.loadLogHistory()

    window.addEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.addEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)

    this.elapsedTimer = setInterval(() => {
      const runner = getTaskRunner()
      if (runner && runner.runningCount > 0) {
        this.updateContent()
      }
    }, 1000)
  }

  disconnectedCallback() {
    this.runnerUnsub?.()
    this.runnerUnsub = null
    window.removeEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.removeEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
  }

  private onTasksChanged = () => {
    this.loadTasks()
  }

  private onRunTaskEvent = (e: CustomEvent<{ taskId: number }>) => {
    const taskId = e.detail?.taskId
    if (typeof taskId === 'number') {
      const runner = getTaskRunner()
      if (runner) {
        runner.runTask(taskId).catch(err => {
          console.error('[TlTaskPanel] run task failed', err)
        })
      }
    }
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="header">Tasks</div>
      <div class="scroll-area" id="content"></div>
    `
    this.updateContent()
  }

  private subscribeRunner() {
    const runner = getTaskRunner()
    if (!runner) {
      const interval = setInterval(() => {
        const r = getTaskRunner()
        if (r) {
          clearInterval(interval)
          this.runnerUnsub = r.subscribe(() => this.updateContent())
          this.updateContent()
        }
      }, 500)
      return
    }
    this.runnerUnsub = runner.subscribe(() => this.updateContent())
  }

  private async loadTasks() {
    const tools = window.agentwfy
    if (!tools) return

    try {
      const rows = await tools.runSql({
        target: 'agent',
        sql: 'SELECT id, name, timeout_ms FROM tasks ORDER BY name ASC',
      }) as TaskItem[]
      this.tasks = Array.isArray(rows) ? rows : []
    } catch {
      this.tasks = []
    }
    this.updateContent()
  }

  private async loadLogHistory() {
    const runner = getTaskRunner()
    if (!runner) return

    try {
      this.logHistory = await runner.listLogHistory()
    } catch {
      this.logHistory = []
    }
    this.updateContent()
  }

  private updateContent() {
    const el = this.shadow.querySelector('#content')
    if (!el) return

    const runner = getTaskRunner()
    const runs = runner ? runner.runs : []
    const hasRuns = runs.length > 0

    let html = ''

    // Active / recent runs
    if (hasRuns) {
      html += `<div class="section-title">Runs</div>`
      for (const run of runs) {
        const expanded = this.expandedRunIds.has(run.runId)
        const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt
        html += `<div class="run-entry">`
        html += `<div class="run-header" data-run-id="${escapeHtml(run.runId)}">`
        html += `<span class="run-status ${run.status}"></span>`
        html += `<span class="run-info">${escapeHtml(run.name)}</span>`
        html += `<span class="run-time">${formatElapsed(elapsed)}</span>`
        if (run.status === 'running') {
          html += `<button class="btn btn-stop" data-stop-run="${escapeHtml(run.runId)}">Stop</button>`
        }
        html += `</div>`
        html += `<div class="run-logs ${expanded ? 'open' : ''}">`
        html += this.renderRunLogs(run)
        html += `</div></div>`
      }
    }

    // Available tasks
    html += `<div class="section-title">Available Tasks</div>`
    if (this.tasks.length === 0) {
      html += `<div class="empty">No tasks defined</div>`
    } else {
      for (const task of this.tasks) {
        html += `<div class="task-item">`
        html += `<span class="task-name">${escapeHtml(task.name)}</span>`
        html += `<button class="btn" data-run-task="${task.id}">Run</button>`
        html += `</div>`
      }
    }

    // Log history
    if (this.logHistory.length > 0) {
      html += `<div class="section-title">History</div>`
      for (const item of this.logHistory) {
        const expanded = this.expandedHistoryFiles.has(item.file)
        html += `<div class="history-item" data-history-file="${escapeHtml(item.file)}">`
        html += `<span class="run-status ${item.status}"></span>`
        html += `<span class="history-name">${escapeHtml(item.taskName)}</span>`
        html += `<span class="history-date">${formatDate(item.updatedAt)}</span>`
        html += `</div>`
        if (expanded) {
          const detail = this.historyDetails.get(item.file) ?? 'Loading...'
          html += `<div class="history-detail open">${escapeHtml(detail)}</div>`
        }
      }
    }

    el.innerHTML = html
    this.attachContentListeners()
  }

  private renderRunLogs(run: TaskRun): string {
    let html = ''
    for (const log of run.logs) {
      const cls = log.level === 'warn' ? ' warn' : log.level === 'error' ? ' error' : ''
      html += `<div class="log-entry${cls}">${escapeHtml(log.message)}</div>`
    }
    if (run.error) {
      html += `<div class="run-error">${escapeHtml(run.error)}</div>`
    }
    if (run.status === 'completed' && run.result !== undefined) {
      const resultStr = typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)
      html += `<div class="log-entry">→ ${escapeHtml(resultStr ?? 'undefined')}</div>`
    }
    return html
  }

  private attachContentListeners() {
    // Run buttons
    this.shadow.querySelectorAll('[data-run-task]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const taskId = Number((btn as HTMLElement).dataset.runTask)
        const runner = getTaskRunner()
        if (runner && taskId) {
          runner.runTask(taskId).catch(err => console.error('[TlTaskPanel] run failed', err))
        }
      })
    })

    // Stop buttons
    this.shadow.querySelectorAll('[data-stop-run]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const runId = (btn as HTMLElement).dataset.stopRun!
        const runner = getTaskRunner()
        if (runner) runner.stopTask(runId)
      })
    })

    // Expand/collapse run logs
    this.shadow.querySelectorAll('.run-header[data-run-id]').forEach(el => {
      el.addEventListener('click', () => {
        const runId = (el as HTMLElement).dataset.runId!
        if (this.expandedRunIds.has(runId)) {
          this.expandedRunIds.delete(runId)
        } else {
          this.expandedRunIds.add(runId)
        }
        this.updateContent()
      })
    })

    // Expand/collapse history
    this.shadow.querySelectorAll('.history-item[data-history-file]').forEach(el => {
      el.addEventListener('click', () => {
        const file = (el as HTMLElement).dataset.historyFile!
        if (this.expandedHistoryFiles.has(file)) {
          this.expandedHistoryFiles.delete(file)
          this.updateContent()
        } else {
          this.expandedHistoryFiles.add(file)
          this.updateContent()
          this.loadHistoryDetail(file)
        }
      })
    })
  }

  private async loadHistoryDetail(file: string) {
    const tools = window.electronClientTools
    if (!tools?.readTaskLog) return

    try {
      const raw = await tools.readTaskLog(file)
      const parsed = JSON.parse(raw)
      let detail = `Status: ${parsed.status}\n`
      if (parsed.startedAt) detail += `Started: ${new Date(parsed.startedAt).toLocaleString()}\n`
      if (parsed.finishedAt) detail += `Finished: ${new Date(parsed.finishedAt).toLocaleString()}\n`
      if (parsed.error) detail += `Error: ${parsed.error}\n`
      if (parsed.result !== null && parsed.result !== undefined) {
        detail += `Result: ${typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2)}\n`
      }
      if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
        detail += `\nLogs:\n`
        for (const log of parsed.logs) {
          detail += `[${log.level}] ${log.message}\n`
        }
      }
      this.historyDetails.set(file, detail)
    } catch {
      this.historyDetails.set(file, 'Failed to load log')
    }

    this.updateContent()
  }
}
