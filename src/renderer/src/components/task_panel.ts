// Task types (mirrored from main process)
type TaskOrigin =
  | { type: 'command-palette' }
  | { type: 'task-panel' }
  | { type: 'agent' }
  | { type: 'trigger'; triggerId: number; triggerType: 'schedule' | 'http' | 'event'; triggerConfig?: string }
  | { type: 'view' }

interface TaskRun {
  runId: string
  taskId: number
  name: string
  status: 'running' | 'completed' | 'failed'
  origin: TaskOrigin
  input?: unknown
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  logs: Array<{ level: string; message: string; timestamp: number }>
  logFile?: string
}

interface TaskLogHistoryItem {
  file: string
  updatedAt: number
  taskName: string
  status: string
  origin?: TaskOrigin
}
import { escapeHtml } from './chat_utils.js'

interface TaskItem {
  id: number
  name: string
  description: string
  timeout_ms: number | null
}

interface TriggerItem {
  id: number
  task_id: number
  type: 'schedule' | 'http' | 'event'
  config: string
  description: string
  enabled: number
  task_name: string
}

const ROW_HEIGHT = 28 // approximate height of a single row
const MAX_ROWS = 10

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family: var(--font-family);
    color: var(--color-text3);
    overflow: hidden;
  }
  .block {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex-shrink: 0;
    border-bottom: 1px solid var(--color-divider, var(--color-border));
  }
  .block.history {
    flex: 1;
    flex-shrink: 1;
    border-bottom: none;
  }
  .block-scroll {
    overflow-y: auto;
    padding: 0 10px 6px;
  }
  .block:not(.history) .block-scroll {
    max-height: ${ROW_HEIGHT * MAX_ROWS}px;
  }
  .block.history .block-scroll {
    flex: 1;
    padding-bottom: 10px;
  }
  .section-header {
    padding: 8px 10px 4px;
    flex-shrink: 0;
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text1);
  }
  .section-count {
    font-size: 10px;
    color: var(--color-text1);
    font-weight: 400;
  }
  .search-box {
    padding: 0 10px 4px;
    flex-shrink: 0;
  }
  .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 8px;
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
  .empty {
    font-size: 12px;
    color: var(--color-text1);
    padding: 6px 8px;
    font-style: italic;
  }
  .task-wrap {
    margin-bottom: 2px;
    border-radius: var(--radius-sm, 4px);
    background: var(--color-item-hover);
  }
  .task-wrap:hover {
    background: var(--color-item-active);
  }
  .task-wrap.expanded {
    background: var(--color-item-active);
  }
  .task-item {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    cursor: pointer;
    font-size: 12px;
    gap: 6px;
  }
  .task-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-detail {
    padding: 2px 8px 8px;
  }
  .task-desc {
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 12px;
    max-height: 160px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text2);
  }
  .run-logs.open { display: block; }
  .run-logs { user-select: text; }
  .run-error {
    color: var(--color-red-fg, #e55);
  }
  .log-entry {
    padding: 1px 0;
  }
  .log-entry.warn { color: var(--color-yellow-fg, #cc8); }
  .log-entry.error { color: var(--color-red-fg, #e55); }
  .trigger-wrap {
    margin-bottom: 2px;
    border-radius: var(--radius-sm, 4px);
  }
  .trigger-wrap:hover {
    background: var(--color-item-hover);
  }
  .trigger-wrap.expanded {
    background: var(--color-item-hover);
  }
  .trigger-item {
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .trigger-item-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .trigger-type {
    font-size: 12px;
    font-family: var(--font-mono);
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--color-bg1);
    color: var(--color-text2);
    flex-shrink: 0;
  }
  .trigger-task {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trigger-desc-full {
    padding-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
    color: var(--color-text3);
  }
  .trigger-detail {
    padding: 2px 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .trigger-detail-row {
    font-size: 12px;
    color: var(--color-text1);
    font-family: var(--font-mono);
  }
  .trigger-detail-label {
    color: var(--color-text2);
  }
  .trigger-disabled {
    opacity: 0.5;
  }
  .history-item {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: var(--radius-sm, 4px);
    font-size: 12px;
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
    font-size: 12px;
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
    font-size: 12px;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--color-text2);
  }
  .history-detail.open { display: block; }
  .history-detail { user-select: text; }
  .origin-tag {
    font-size: 10px;
    color: var(--color-text1);
  }
`


function originLabel(origin?: TaskOrigin): string {
  if (!origin) return ''
  switch (origin.type) {
    case 'command-palette': return 'cmd'
    case 'task-panel': return 'panel'
    case 'agent': return 'agent'
    case 'trigger': return origin.triggerType
    case 'view': return 'view'
    default: return ''
  }
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

function formatTriggerConfig(type: string, config: string): string {
  try {
    const parsed = JSON.parse(config)
    switch (type) {
      case 'schedule': return parsed.expression || ''
      case 'http': return `${(parsed.method || 'POST').toUpperCase()} ${parsed.path || ''}`
      case 'event': return parsed.topic || ''
      default: return ''
    }
  } catch {
    return ''
  }
}

export class TlTaskPanel extends HTMLElement {
  private shadow: ShadowRoot
  private tasks: TaskItem[] = []
  private triggers: TriggerItem[] = []
  private logHistory: TaskLogHistoryItem[] = []
  private expandedTaskId: number | null = null
  private expandedTriggerId: number | null = null
  private expandedRunIds = new Set<string>()
  private expandedHistoryFiles = new Set<string>()
  private historyDetails = new Map<string, string>()
  private renderedLogCounts = new Map<string, number>()
  private searchQuery = ''

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  connectedCallback() {
    this.render()
    this.loadTasks()
    this.loadTriggers()
    this.loadLogHistory()

    window.addEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.addEventListener('agentwfy:triggers-db-changed', this.onTriggersChanged)
    window.addEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)
  }

  disconnectedCallback() {
    this.renderedLogCounts.clear()
    window.removeEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.removeEventListener('agentwfy:triggers-db-changed', this.onTriggersChanged)
    window.removeEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)
  }

  private onTasksChanged = () => {
    this.loadTasks()
  }

  private onTriggersChanged = () => {
    this.loadTriggers()
  }

  private onRunTaskEvent = (e: CustomEvent<{ taskId: number; input?: string }>) => {
    const taskId = e.detail?.taskId
    if (typeof taskId === 'number') {
      const ipc = window.ipc
      if (ipc) {
        const input = e.detail?.input
        ipc.tasks.start(taskId, input || undefined, { type: 'command-palette' } as any).catch(err => {
          console.error('[TlTaskPanel] run task failed', err)
        })
      }
    }
  }

  private render() {
    this.shadow.innerHTML = `<style>${STYLES}</style><div id="root" style="display:flex;flex-direction:column;height:100%;overflow:hidden;"></div>`
    this.updateContent()
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

  private async loadTriggers() {
    const ipc = window.ipc
    if (!ipc) return

    try {
      const rows = await ipc.sql.run({
        target: 'agent',
        sql: `SELECT t.id, t.task_id, t.type, t.config, t.description, t.enabled, k.name as task_name
              FROM triggers t
              LEFT JOIN tasks k ON t.task_id = k.id
              ORDER BY t.enabled DESC, k.name ASC`,
      }) as TriggerItem[]
      this.triggers = Array.isArray(rows) ? rows : []
    } catch {
      this.triggers = []
    }
    this.updateContent()
  }

  private async loadLogHistory() {
    const ipc = window.ipc
    if (!ipc) return

    try {
      this.logHistory = await ipc.tasks.listLogHistory() as TaskLogHistoryItem[]
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
    const root = this.shadow.querySelector('#root')
    if (!root) return

    const activeRuns: TaskRun[] = []
    const filteredTasks = this.getFilteredTasks()

    let html = ''

    // === Block 1: Running Tasks ===
    html += `<div class="block">`
    html += `<div class="section-header"><span class="section-title">Running${activeRuns.length > 0 ? ` <span class="section-count">${activeRuns.length}</span>` : ''}</span></div>`
    html += `<div class="block-scroll">`
    if (activeRuns.length === 0) {
      html += `<div class="empty">No running tasks</div>`
    } else {
      for (const run of activeRuns) {
        const expanded = this.expandedRunIds.has(run.runId)
        const elapsed = Date.now() - run.startedAt
        const oLabel = originLabel(run.origin)
        html += `<div class="run-entry">`
        html += `<div class="run-header" data-run-id="${escapeHtml(run.runId)}">`
        html += `<span class="run-status running"></span>`
        html += `<span class="run-info">${escapeHtml(run.name)}</span>`
        if (oLabel) html += `<span class="trigger-type origin-tag">${escapeHtml(oLabel)}</span>`
        html += `<span class="run-time">${formatElapsed(elapsed)}</span>`
        html += `<button class="btn btn-stop" data-stop-run="${escapeHtml(run.runId)}">Stop</button>`
        html += `</div>`
        html += `<div class="run-logs ${expanded ? 'open' : ''}">`
        html += this.renderRunLogs(run)
        html += `</div></div>`
      }
    }
    html += `</div></div>`

    // === Block 2: Available Tasks with filter ===
    html += `<div class="block">`
    html += `<div class="section-header"><span class="section-title">Tasks <span class="section-count">${filteredTasks.length}</span></span></div>`
    html += `<div class="search-box">`
    html += `<input class="search-input" type="text" placeholder="Filter tasks..." autocomplete="off" spellcheck="false" value="${escapeHtml(this.searchQuery)}" />`
    html += `</div>`
    html += `<div class="block-scroll">`
    if (filteredTasks.length === 0 && this.tasks.length > 0) {
      html += `<div class="empty">No matching tasks</div>`
    } else if (filteredTasks.length === 0) {
      html += `<div class="empty">No tasks defined</div>`
    } else {
      for (const task of filteredTasks) {
        const isExpanded = this.expandedTaskId === task.id
        html += `<div class="task-wrap${isExpanded ? ' expanded' : ''}">`
        html += `<div class="task-item" data-task-id="${task.id}">`
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
        html += `</div>`
      }
    }
    html += `</div></div>`

    // === Block 3: Triggers ===
    html += `<div class="block">`
    html += `<div class="section-header"><span class="section-title">Triggers <span class="section-count">${this.triggers.length}</span></span></div>`
    html += `<div class="block-scroll">`
    if (this.triggers.length === 0) {
      html += `<div class="empty">No triggers defined</div>`
    } else {
      for (const trigger of this.triggers) {
        const disabled = !trigger.enabled
        const isExpanded = this.expandedTriggerId === trigger.id
        const configInfo = formatTriggerConfig(trigger.type, trigger.config)
        const label = trigger.description || trigger.task_name || `task #${trigger.task_id}`
        html += `<div class="trigger-wrap${disabled ? ' trigger-disabled' : ''}${isExpanded ? ' expanded' : ''}">`
        html += `<div class="trigger-item" data-trigger-id="${trigger.id}">`
        html += `<div class="trigger-item-row">`
        html += `<span class="trigger-type">${escapeHtml(trigger.type)}</span>`
        html += `<span class="trigger-task">${escapeHtml(label)}</span>`
        html += `</div>`
        if (isExpanded && trigger.description) {
          html += `<div class="trigger-desc-full">${escapeHtml(trigger.description)}</div>`
        }
        html += `</div>`
        if (isExpanded) {
          html += `<div class="trigger-detail">`
          html += `<div class="trigger-detail-row"><span class="trigger-detail-label">task </span>${escapeHtml(trigger.task_name || `#${trigger.task_id}`)}</div>`
          if (configInfo) {
            html += `<div class="trigger-detail-row"><span class="trigger-detail-label">config </span>${escapeHtml(configInfo)}</div>`
          }
          html += `</div>`
        }
        html += `</div>`
      }
    }
    html += `</div></div>`

    // === Block 4: History (takes remaining space) ===
    html += `<div class="block history">`
    html += `<div class="section-header"><span class="section-title">History${this.logHistory.length > 0 ? ` <span class="section-count">${this.logHistory.length}</span>` : ''}</span></div>`
    html += `<div class="block-scroll">`
    if (this.logHistory.length === 0) {
      html += `<div class="empty">No history yet</div>`
    } else {
      for (const item of this.logHistory) {
        const expanded = this.expandedHistoryFiles.has(item.file)
        const hLabel = originLabel(item.origin)
        html += `<div class="history-item" data-history-file="${escapeHtml(item.file)}">`
        html += `<span class="run-status ${item.status}"></span>`
        html += `<span class="history-name">${escapeHtml(item.taskName)}</span>`
        if (hLabel) html += `<span class="trigger-type origin-tag">${escapeHtml(hLabel)}</span>`
        html += `<span class="history-date">${formatDate(item.updatedAt)}</span>`
        html += `</div>`
        if (expanded) {
          const detail = this.historyDetails.get(item.file) ?? 'Loading...'
          html += `<div class="history-detail open">${escapeHtml(detail)}</div>`
        }
      }
    }
    html += `</div></div>`

    root.innerHTML = html
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
    const runs: TaskRun[] = [] // TODO: Stream running task state from main process
    for (const run of runs) {
      if (run.status !== 'running') continue

      const header = this.shadow.querySelector(`.run-header[data-run-id="${run.runId}"]`)
      if (!header) continue
      const timeEl = header.querySelector('.run-time')
      if (timeEl) {
        timeEl.textContent = formatElapsed(Date.now() - run.startedAt)
      }

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
    // Search input
    const searchInput = this.shadow.querySelector('.search-input') as HTMLInputElement | null
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.searchQuery = searchInput.value.trim().toLowerCase()
        this.updateContent()
      })
      // Restore cursor position after re-render
      if (this.searchQuery) {
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length)
      }
    }

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
        window.ipc?.tasks.stop(runId).catch(() => {})
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

    // Expand/collapse trigger description
    this.shadow.querySelectorAll('.trigger-item[data-trigger-id]').forEach(el => {
      el.addEventListener('click', () => {
        const triggerId = Number((el as HTMLElement).dataset.triggerId)
        this.expandedTriggerId = this.expandedTriggerId === triggerId ? null : triggerId
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
    const ipc = window.ipc
    if (ipc) {
      ipc.tasks.start(taskId, inputValue, { type: 'task-panel' } as any).then(() => {
        this.loadLogHistory()
      }).catch(err => console.error('[TlTaskPanel] run with input failed', err))
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
      if (parsed.origin) {
        const label = originLabel(parsed.origin as TaskOrigin)
        if (label) detail += `Origin: ${label}\n`
        if (parsed.origin.type === 'trigger' && parsed.origin.triggerConfig) {
          detail += `Trigger: ${parsed.origin.triggerConfig}\n`
        }
      }
      if (parsed.startedAt) detail += `Started: ${new Date(parsed.startedAt).toLocaleString()}\n`
      if (parsed.finishedAt) detail += `Finished: ${new Date(parsed.finishedAt).toLocaleString()}\n`
      if (parsed.input !== null && parsed.input !== undefined) {
        detail += `Input: ${typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input, null, 2)}\n`
      }
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
