import { getTaskRunner } from '../tasks/task_runner.js'
import type { TaskRun, TaskLogHistoryItem } from '../tasks/task_runner.js'

interface TaskItem {
  id: number
  name: string
  description: string
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
  .search-box {
    padding: 8px 10px;
    flex-shrink: 0;
  }
  .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg1);
    color: var(--color-text3);
    outline: none;
  }
  .search-input:focus {
    border-color: var(--color-accent, #58a6ff);
  }
  .search-input::placeholder {
    color: var(--color-text1);
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
  .section-title:first-child {
    padding-top: 0;
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
    padding: 5px 8px;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    font-size: 12px;
    gap: 6px;
  }
  .task-item:hover {
    background: var(--color-item-hover);
  }
  .task-item.expanded {
    background: var(--color-item-hover);
  }
  .task-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-detail {
    padding: 4px 8px 8px;
  }
  .task-desc {
    font-size: 11px;
    color: var(--color-text1);
    padding-bottom: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
  }
  .task-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .task-input {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font-size: 11px;
    font-family: var(--font-mono);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    background: var(--color-bg1);
    color: var(--color-text3);
    outline: none;
  }
  .task-input:focus {
    border-color: var(--color-accent, #58a6ff);
  }
  .task-input::placeholder {
    color: var(--color-text1);
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
    white-space: nowrap;
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

function logLevelClass(level: string): string {
  return level === 'warn' ? ' warn' : level === 'error' ? ' error' : ''
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
  private expandedTaskId: number | null = null
  private expandedRunIds = new Set<string>()
  private expandedHistoryFiles = new Set<string>()
  private historyDetails = new Map<string, string>()
  private renderedLogCounts = new Map<string, number>()
  private runnerUnsub: (() => void) | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private searchQuery = ''
  private prevRunCount = 0

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
        this.updateRunningRuns()
      }
    }, 1000)
  }

  disconnectedCallback() {
    const runner = getTaskRunner()
    if (runner) {
      for (const runId of this.expandedRunIds) {
        runner.unwatchRun(runId)
      }
    }
    this.runnerUnsub?.()
    this.runnerUnsub = null
    this.renderedLogCounts.clear()
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

  private onRunTaskEvent = (e: CustomEvent<{ taskId: number; input?: string }>) => {
    const taskId = e.detail?.taskId
    if (typeof taskId === 'number') {
      const runner = getTaskRunner()
      if (runner) {
        const input = e.detail?.input
        runner.runTask(taskId, input || undefined).catch(err => {
          console.error('[TlTaskPanel] run task failed', err)
        })
      }
    }
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${STYLES}</style>
      <div class="search-box">
        <input class="search-input" type="text" placeholder="Filter tasks..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="scroll-area" id="content"></div>
    `
    const searchInput = this.shadow.querySelector('.search-input') as HTMLInputElement
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.trim().toLowerCase()
      this.updateContent()
    })
    this.updateContent()
  }

  private subscribeRunner() {
    const runner = getTaskRunner()
    if (!runner) {
      const interval = setInterval(() => {
        const r = getTaskRunner()
        if (r) {
          clearInterval(interval)
          this.runnerUnsub = r.subscribe(() => this.onRunnerUpdate())
          this.updateContent()
        }
      }, 500)
      return
    }
    this.runnerUnsub = runner.subscribe(() => this.onRunnerUpdate())
  }

  private onRunnerUpdate() {
    const runner = getTaskRunner()
    if (!runner) return

    const currentRunning = runner.runs.filter(r => r.status === 'running').length
    const wasRunning = this.prevRunCount

    this.updateContent()

    // A run just finished — reload history
    if (currentRunning < wasRunning) {
      this.loadLogHistory()
    }
    this.prevRunCount = currentRunning
  }

  private async loadTasks() {
    const ipc = window.ipc
    if (!ipc) return

    try {
      const rows = await ipc.sql.run({
        target: 'agent',
        sql: 'SELECT id, name, description, timeout_ms FROM tasks ORDER BY name ASC',
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

  private getFilteredTasks(): TaskItem[] {
    if (!this.searchQuery) return this.tasks
    return this.tasks.filter(t =>
      t.name.toLowerCase().includes(this.searchQuery) ||
      (t.description && t.description.toLowerCase().includes(this.searchQuery))
    )
  }

  private updateContent() {
    const el = this.shadow.querySelector('#content')
    if (!el) return

    const runner = getTaskRunner()
    const allRuns = runner ? runner.runs : []
    const activeRuns = allRuns.filter(r => r.status === 'running')
    const filteredTasks = this.getFilteredTasks()

    let html = ''

    // Active runs (only running tasks)
    if (activeRuns.length > 0) {
      html += `<div class="section-title">Active</div>`
      for (const run of activeRuns) {
        const expanded = this.expandedRunIds.has(run.runId)
        const elapsed = Date.now() - run.startedAt
        html += `<div class="run-entry">`
        html += `<div class="run-header" data-run-id="${escapeHtml(run.runId)}">`
        html += `<span class="run-status running"></span>`
        html += `<span class="run-info">${escapeHtml(run.name)}</span>`
        html += `<span class="run-time">${formatElapsed(elapsed)}</span>`
        html += `<button class="btn btn-stop" data-stop-run="${escapeHtml(run.runId)}">Stop</button>`
        html += `</div>`
        html += `<div class="run-logs ${expanded ? 'open' : ''}">`
        html += this.renderRunLogs(run)
        html += `</div></div>`
      }
    }

    // Task list
    if (filteredTasks.length === 0 && this.tasks.length > 0) {
      html += `<div class="empty">No matching tasks</div>`
    } else if (filteredTasks.length === 0) {
      html += `<div class="empty">No tasks defined</div>`
    } else {
      for (const task of filteredTasks) {
        const isExpanded = this.expandedTaskId === task.id
        html += `<div class="task-item${isExpanded ? ' expanded' : ''}" data-task-id="${task.id}">`
        html += `<span class="task-name">${escapeHtml(task.name)}</span>`
        html += `</div>`
        if (isExpanded) {
          html += `<div class="task-detail">`
          if (task.description) {
            html += `<div class="task-desc">${escapeHtml(task.description)}</div>`
          }
          html += `<div class="task-actions">`
          html += `<input class="task-input" data-input-task="${task.id}" placeholder="Input (optional)" />`
          html += `<button class="btn" data-run-task="${task.id}">Run</button>`
          html += `</div>`
          html += `</div>`
        }
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

    // Track rendered log counts for expanded runs
    for (const run of activeRuns) {
      if (this.expandedRunIds.has(run.runId)) {
        this.renderedLogCounts.set(run.runId, run.logs.length)
      }
    }

    // Focus input if a task is expanded
    if (this.expandedTaskId !== null) {
      const inputEl = this.shadow.querySelector(`.task-input[data-input-task="${this.expandedTaskId}"]`) as HTMLInputElement | null
      if (inputEl) inputEl.focus()
    }
  }

  private updateRunningRuns() {
    const runner = getTaskRunner()
    if (!runner) return

    for (const run of runner.runs) {
      if (run.status !== 'running') continue

      // Update elapsed time
      const header = this.shadow.querySelector(`.run-header[data-run-id="${run.runId}"]`)
      if (!header) continue
      const timeEl = header.querySelector('.run-time')
      if (timeEl) {
        timeEl.textContent = formatElapsed(Date.now() - run.startedAt)
      }

      // Append new log entries
      if (!this.expandedRunIds.has(run.runId)) continue
      const logsEl = header.nextElementSibling
      if (!logsEl) continue

      const rendered = this.renderedLogCounts.get(run.runId) ?? 0
      if (run.logs.length > rendered) {
        for (let i = rendered; i < run.logs.length; i++) {
          const log = run.logs[i]
          const cls = logLevelClass(log.level)
          const div = document.createElement('div')
          div.className = `log-entry${cls}`
          div.textContent = log.message
          logsEl.appendChild(div)
        }
        this.renderedLogCounts.set(run.runId, run.logs.length)
      }
    }
  }

  private renderRunLogs(run: TaskRun): string {
    let html = ''
    for (const log of run.logs) {
      const cls = logLevelClass(log.level)
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
    // Task item click — toggle expand
    this.shadow.querySelectorAll('.task-item[data-task-id]').forEach(el => {
      el.addEventListener('click', () => {
        const taskId = Number((el as HTMLElement).dataset.taskId)
        this.expandedTaskId = this.expandedTaskId === taskId ? null : taskId
        this.updateContent()
      })
    })

    // Run buttons
    this.shadow.querySelectorAll('[data-run-task]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const taskId = Number((btn as HTMLElement).dataset.runTask)
        this.runWithInput(taskId)
      })
    })

    // Enter key on input fields
    this.shadow.querySelectorAll('.task-input[data-input-task]').forEach(el => {
      el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          e.preventDefault()
          const taskId = Number((el as HTMLInputElement).dataset.inputTask)
          this.runWithInput(taskId)
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
        const runner = getTaskRunner()
        if (this.expandedRunIds.has(runId)) {
          this.expandedRunIds.delete(runId)
          if (runner) runner.unwatchRun(runId)
        } else {
          this.expandedRunIds.add(runId)
          if (runner) runner.watchRun(runId)
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

  private runWithInput(taskId: number) {
    if (!taskId) return
    const inputEl = this.shadow.querySelector(`.task-input[data-input-task="${taskId}"]`) as HTMLInputElement | null
    const inputValue = inputEl?.value?.trim() || undefined
    const runner = getTaskRunner()
    if (runner) {
      runner.runTask(taskId, inputValue).catch(err => console.error('[TlTaskPanel] run with input failed', err))
      if (inputEl) inputEl.value = ''
    }
  }

  private async loadHistoryDetail(file: string) {
    const ipc = window.ipc
    if (!ipc) return

    try {
      const raw = await ipc.tasks.readLog(file)
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
