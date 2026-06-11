// Mobile task surface: shows running tasks, persisted run logs, and saved
// tasks that can be launched from the phone UI. Runtime state comes from the
// remote backend; task definitions come from the local SQLite mirror.

import type {
  RunningTaskSummary,
  TaskLogHistoryItem,
} from '#shared/backend/interface.js'
import type {
  TaskOrigin,
  TaskRunFinishedPayload,
  TaskRunRead,
} from '#shared/task-runner/task_runner.js'
import { backendSession } from '../services/backend-session.js'
import { dispatch, listen, type MobileEventMap } from '../events.js'
import { bridge } from '../tauri-bridge.js'
import { ICON_BACK, ICON_PLAY, ICON_STOP } from './icons.js'
import { escapeHtml, formatDuration, formatRelative } from './util.js'

interface TaskItem {
  name: string
  title: string
  description: string
  timeout_ms: number | null
}

interface LogEntry {
  level: string
  message: string
  timestamp?: number
}

interface LogDetail {
  runId?: string
  taskName: string
  title: string
  status: string
  origin?: TaskOrigin
  input?: unknown
  startedAt?: number
  finishedAt?: number | null
  result?: unknown
  error?: string | null
  logs: LogEntry[]
}

type ActiveTab = 'runs' | 'tasks'

export class TlTaskList extends HTMLElement {
  private activeTab: ActiveTab = 'runs'
  private activeRuns: RunningTaskSummary[] = []
  private logHistory: TaskLogHistoryItem[] = []
  private tasks: TaskItem[] = []
  private detail: LogDetail | null = null
  private expandedTaskName: string | null = null
  private refreshSeq = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubs: Array<() => void> = []

  connectedCallback() {
    this.className = 'task-list'
    this.unsubs.push(
      listen('agent-switched', () => {
        this.refreshSeq++
        this.activeRuns = []
        this.logHistory = []
        this.tasks = []
        this.detail = null
        this.expandedTaskName = null
        this.render()
        void this.refreshAll()
      }),
      listen('snapshot-applied', () => { void this.refreshAll() }),
      listen('db-change', ({ change }) => {
        if (change.table === 'tasks') void this.refreshTasks()
      }),
      listen('status-changed', () => this.render()),
      listen('task-run-started', ({ payload }) => {
        this.upsertActiveRun(payload)
        this.activeTab = 'runs'
        this.render()
      }),
      listen('task-run-log', ({ payload }) => this.handleRunLog(payload)),
      listen('task-run-finished', ({ payload }) => this.handleRunFinished(payload)),
    )

    this.timer = setInterval(() => {
      if (this.activeRuns.length > 0 || this.detail?.status === 'running') this.patchElapsedLabels()
    }, 1000)

    this.render()
    void this.refreshAll()
  }

  disconnectedCallback() {
    for (const off of this.unsubs) off()
    this.unsubs.length = 0
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async refreshAll(): Promise<void> {
    const seq = ++this.refreshSeq
    await Promise.all([
      this.refreshTasks(seq),
      this.refreshRuns(seq),
      this.refreshHistory(seq),
    ])
  }

  private async refreshRuns(seq = this.refreshSeq): Promise<void> {
    const backend = backendSession.getBackend()
    if (!backend) {
      this.activeRuns = []
      this.render()
      return
    }
    try {
      const rows = await backend.tasks.listRunning()
      if (seq !== this.refreshSeq) return
      this.activeRuns = rows
    } catch {
      if (seq !== this.refreshSeq) return
      this.activeRuns = []
    }
    this.render()
  }

  private async refreshHistory(seq = this.refreshSeq): Promise<void> {
    const backend = backendSession.getBackend()
    if (!backend) {
      this.logHistory = []
      this.render()
      return
    }
    try {
      const rows = await backend.tasks.listLogHistory()
      if (seq !== this.refreshSeq) return
      this.logHistory = rows
    } catch {
      if (seq !== this.refreshSeq) return
      this.logHistory = []
    }
    this.render()
  }

  private async refreshTasks(seq = this.refreshSeq): Promise<void> {
    const agentId = backendSession.getActiveAgentId()
    if (!agentId) {
      this.tasks = []
      this.render()
      return
    }
    try {
      const rows = await bridge.mirrorDb.query(
        agentId,
        `SELECT name, title, description, timeout_ms
FROM tasks
WHERE name NOT LIKE 'system.%' AND name NOT LIKE 'plugin.%'
ORDER BY title ASC`,
      )
      if (seq !== this.refreshSeq || backendSession.getActiveAgentId() !== agentId) return
      this.tasks = rows.map(parseTaskRow).filter((task): task is TaskItem => task !== null)
    } catch {
      if (seq !== this.refreshSeq) return
      this.tasks = []
    }
    this.render()
  }

  private render(): void {
    if (this.detail) {
      this.innerHTML = renderDetail(this.detail)
      this.bindDetailHandlers()
      return
    }

    this.innerHTML = `
      <div class="section-header task-section-header">
        <div>
          <div class="section-title">Tasks</div>
          <div class="task-section-subtitle">${escapeHtml(this.summaryText())}</div>
        </div>
      </div>
      <div class="task-tabs" role="tablist" aria-label="Task views">
        <button type="button" class="task-tab ${this.activeTab === 'runs' ? 'is-active' : ''}" data-tab="runs">
          Runs${this.activeRuns.length > 0 ? ` <span>${this.activeRuns.length}</span>` : ''}
        </button>
        <button type="button" class="task-tab ${this.activeTab === 'tasks' ? 'is-active' : ''}" data-tab="tasks">
          Tasks${this.tasks.length > 0 ? ` <span>${this.tasks.length}</span>` : ''}
        </button>
      </div>
      <div class="task-scroll" data-role="content">
        ${this.activeTab === 'runs' ? this.renderRuns() : this.renderTasks()}
      </div>
    `
    this.bindListHandlers()
  }

  private summaryText(): string {
    if (!backendSession.getBackend()) return 'Connect an agent to see task activity.'
    if (this.activeRuns.length > 0) {
      return `${this.activeRuns.length} running, ${this.logHistory.length} recent`
    }
    if (this.logHistory.length > 0) return `${this.logHistory.length} recent runs`
    if (this.tasks.length > 0) return `${this.tasks.length} saved tasks`
    return 'No task runs yet.'
  }

  private renderRuns(): string {
    const parts: string[] = []
    for (const run of this.activeRuns) parts.push(renderActiveRun(run))
    if (this.activeRuns.length > 0 && this.logHistory.length > 0) {
      parts.push(`<div class="task-list-divider"></div>`)
    }
    for (const item of this.logHistory) parts.push(renderHistoryRun(item))
    if (parts.length === 0) {
      return `<div class="empty-list">No task runs yet. Run a saved task or wait for a trigger.</div>`
    }
    return parts.join('')
  }

  private renderTasks(): string {
    if (this.tasks.length === 0) {
      return `<div class="empty-list">No user tasks defined for this agent.</div>`
    }
    return this.tasks.map((task) => renderTask(task, this.expandedTaskName === task.name)).join('')
  }

  private bindListHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab
        if (tab === 'runs' || tab === 'tasks') {
          this.activeTab = tab
          this.expandedTaskName = null
          this.render()
        }
      })
    })

    this.querySelectorAll<HTMLButtonElement>('[data-open-run]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const runId = btn.dataset.openRun
        const run = this.activeRuns.find((candidate) => candidate.runId === runId)
        if (run) void this.openRunningDetail(run)
      })
    })

    this.querySelectorAll<HTMLButtonElement>('[data-open-log]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.openLog
        const item = this.logHistory.find((candidate) => candidate.file === file)
        if (item) void this.openHistoryDetail(item)
      })
    })

    this.querySelectorAll<HTMLButtonElement>('[data-stop-run]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation()
        const runId = btn.dataset.stopRun
        if (runId) void this.stopRun(runId)
      })
    })

    this.querySelectorAll<HTMLButtonElement>('[data-expand-task]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const taskName = btn.dataset.expandTask
        if (!taskName) return
        this.expandedTaskName = this.expandedTaskName === taskName ? null : taskName
        this.render()
      })
    })

    this.querySelectorAll<HTMLButtonElement>('[data-run-task]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation()
        const taskName = btn.dataset.runTask
        if (taskName) void this.runTask(taskName)
      })
    })

    this.querySelectorAll<HTMLInputElement>('[data-task-input]').forEach((input) => {
      input.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter') return
        evt.preventDefault()
        const taskName = input.dataset.taskInput
        if (taskName) void this.runTask(taskName)
      })
    })
  }

  private bindDetailHandlers(): void {
    this.querySelector<HTMLButtonElement>('[data-back]')?.addEventListener('click', () => {
      this.detail = null
      this.render()
    })
    this.querySelector<HTMLButtonElement>('[data-detail-stop]')?.addEventListener('click', () => {
      if (this.detail?.runId) void this.stopRun(this.detail.runId)
    })
    this.querySelector<HTMLButtonElement>('[data-copy-logs]')?.addEventListener('click', () => {
      const logs = this.detail?.logs ?? []
      const text = logs.map((log) => `${formatLogTime(log.timestamp)} [${log.level}] ${log.message}`).join('\n')
      void navigator.clipboard?.writeText(text)
    })
  }

  private async runTask(taskName: string): Promise<void> {
    const backend = backendSession.getBackend()
    if (!backend || backendSession.getStatus().state !== 'connected') {
      dispatch('error', { message: 'Remote agent is not connected.' })
      return
    }
    const inputEl = this.querySelector<HTMLInputElement>(`[data-task-input="${cssEscape(taskName)}"]`)
    const input = inputEl?.value.trim() || undefined
    try {
      await backend.tasks.start({ taskName, input, origin: { type: 'task-panel' } })
      if (inputEl) inputEl.value = ''
      this.expandedTaskName = null
      this.activeTab = 'runs'
      dispatch('error', { message: null })
      this.render()
      void this.refreshRuns()
    } catch (err) {
      dispatch('error', { message: `Starting task failed: ${messageFromUnknown(err)}` })
    }
  }

  private async stopRun(runId: string): Promise<void> {
    const backend = backendSession.getBackend()
    if (!backend) return
    try {
      await backend.tasks.stop({ runId })
      dispatch('error', { message: null })
    } catch (err) {
      dispatch('error', { message: `Stopping task failed: ${messageFromUnknown(err)}` })
    }
  }

  private async openRunningDetail(run: RunningTaskSummary): Promise<void> {
    this.detail = {
      runId: run.runId,
      taskName: run.taskName,
      title: run.title || run.taskName,
      status: run.status,
      origin: run.origin,
      startedAt: run.startedAt,
      logs: [],
    }
    this.render()

    const backend = backendSession.getBackend()
    if (!backend) return
    try {
      const detail = await backend.tasks.readRun({ runId: run.runId })
      if (this.detail?.runId !== run.runId) return
      this.detail = detailFromRead(detail)
      this.render()
    } catch (err) {
      if (this.detail?.runId !== run.runId) return
      this.detail.error = messageFromUnknown(err)
      this.render()
    }
  }

  private async openHistoryDetail(item: TaskLogHistoryItem): Promise<void> {
    this.detail = {
      taskName: item.taskName,
      title: item.taskName,
      status: item.status,
      origin: item.origin,
      finishedAt: item.updatedAt,
      logs: [],
    }
    this.render()

    const backend = backendSession.getBackend()
    if (!backend) return
    try {
      const raw = await backend.tasks.readLog({ logFileName: item.file })
      const parsed = JSON.parse(raw) as Record<string, unknown>
      this.detail = detailFromLogFile(parsed, item)
    } catch (err) {
      this.detail = {
        taskName: item.taskName,
        title: item.taskName,
        status: 'failed',
        error: `Failed to load log file: ${messageFromUnknown(err)}`,
        logs: [],
      }
    }
    this.render()
  }

  private handleRunLog(payload: MobileEventMap['task-run-log']['payload']): void {
    if (!this.detail?.runId || this.detail.runId !== payload.runId) return
    const logs = this.detail.logs
    if (payload.logIndex >= 0 && payload.logIndex < logs.length) logs[payload.logIndex] = payload.log
    else logs.push(payload.log)
    this.detail.status = payload.status
    this.detail.startedAt = payload.startedAt
    this.detail.origin = payload.origin
    this.render()
    const scroll = this.querySelector<HTMLElement>('[data-role="logs"]')
    if (scroll) scroll.scrollTop = scroll.scrollHeight
  }

  private handleRunFinished(payload: TaskRunFinishedPayload): void {
    this.activeRuns = this.activeRuns.filter((run) => run.runId !== payload.runId)
    if (payload.logFile) {
      this.logHistory = [
        {
          file: payload.logFile,
          updatedAt: payload.finishedAt ?? Date.now(),
          taskName: payload.title || payload.taskName,
          status: payload.status,
          origin: payload.origin,
        },
        ...this.logHistory.filter((item) => item.file !== payload.logFile),
      ].slice(0, 50)
    }
    if (this.detail?.runId === payload.runId) {
      this.detail = {
        runId: payload.runId,
        taskName: payload.taskName,
        title: payload.title || payload.taskName,
        status: payload.status,
        origin: payload.origin,
        startedAt: payload.startedAt,
        finishedAt: payload.finishedAt ?? null,
        result: payload.result,
        error: payload.error ?? null,
        logs: payload.logs,
      }
    }
    this.render()
  }

  private upsertActiveRun(run: RunningTaskSummary): void {
    this.activeRuns = [run, ...this.activeRuns.filter((candidate) => candidate.runId !== run.runId)]
  }

  private patchElapsedLabels(): void {
    this.querySelectorAll<HTMLElement>('[data-elapsed-run]').forEach((el) => {
      const run = this.activeRuns.find((candidate) => candidate.runId === el.dataset.elapsedRun)
      if (run) el.textContent = formatDuration(Date.now() - run.startedAt)
    })
    const detailElapsed = this.querySelector<HTMLElement>('[data-detail-elapsed]')
    if (detailElapsed && this.detail?.startedAt) {
      const end = this.detail.finishedAt ?? Date.now()
      detailElapsed.textContent = formatDuration(end - this.detail.startedAt)
    }
  }
}

function renderActiveRun(run: RunningTaskSummary): string {
  const origin = originLabel(run.origin)
  return `
    <div class="task-run-row is-running">
      <button type="button" class="task-run-main" data-open-run="${escapeHtml(run.runId)}">
        <span class="task-run-title">${escapeHtml(run.title || run.taskName)}</span>
        <span class="task-run-meta">
          ${origin ? `<span class="task-pill">${escapeHtml(origin)}</span>` : ''}
          <span>${escapeHtml(run.runId.slice(0, 12))}</span>
        </span>
      </button>
      <div class="task-run-side">
        <span class="task-run-time" data-elapsed-run="${escapeHtml(run.runId)}">${escapeHtml(formatDuration(Date.now() - run.startedAt))}</span>
        <button type="button" class="task-icon-action danger" data-stop-run="${escapeHtml(run.runId)}" aria-label="Stop task" title="Stop task">${ICON_STOP}</button>
      </div>
    </div>
  `
}

function renderHistoryRun(item: TaskLogHistoryItem): string {
  const failed = item.status === 'failed'
  const origin = originLabel(item.origin)
  return `
    <div class="task-run-row ${failed ? 'is-failed' : ''}">
      <button type="button" class="task-run-main" data-open-log="${escapeHtml(item.file)}">
        <span class="task-run-title">${escapeHtml(item.taskName)}</span>
        <span class="task-run-meta">
          <span class="task-status-dot ${failed ? 'failed' : 'ok'}"></span>
          <span>${escapeHtml(item.status)}</span>
          ${origin ? `<span class="task-pill">${escapeHtml(origin)}</span>` : ''}
        </span>
      </button>
      <span class="task-run-date">${escapeHtml(formatRelative(item.updatedAt))}</span>
    </div>
  `
}

function renderTask(task: TaskItem, expanded: boolean): string {
  const timeout = typeof task.timeout_ms === 'number' && task.timeout_ms > 0
    ? `Timeout ${formatDuration(task.timeout_ms)}`
    : ''
  return `
    <div class="task-card ${expanded ? 'is-expanded' : ''}">
      <div class="task-card-top">
        <button type="button" class="task-card-main" data-expand-task="${escapeHtml(task.name)}">
          <span class="task-run-title">${escapeHtml(task.title || task.name)}</span>
          <span class="task-run-meta">${escapeHtml(task.description || task.name)}</span>
          ${timeout ? `<span class="task-run-meta">${escapeHtml(timeout)}</span>` : ''}
        </button>
        <button type="button" class="task-icon-action" data-run-task="${escapeHtml(task.name)}" aria-label="Run task" title="Run task">${ICON_PLAY}</button>
      </div>
      ${expanded ? `
        <div class="task-input-row">
          <input class="input task-input" data-task-input="${escapeHtml(task.name)}" placeholder="Input (optional)" />
          <button type="button" class="btn compact primary" data-run-task="${escapeHtml(task.name)}">Run</button>
        </div>
      ` : ''}
    </div>
  `
}

function renderDetail(detail: LogDetail): string {
  const running = detail.status === 'running'
  const duration = detail.startedAt ? (detail.finishedAt ?? Date.now()) - detail.startedAt : 0
  const input = detail.input !== undefined && detail.input !== null ? stringifyValue(detail.input) : ''
  const result = detail.result !== undefined && detail.result !== null ? stringifyValue(detail.result) : ''
  const origin = originLabel(detail.origin)
  return `
    <div class="task-detail">
      <div class="task-detail-header">
        <button type="button" class="icon-btn" data-back aria-label="Back" title="Back">${ICON_BACK}</button>
        <div class="task-detail-title">
          <h2>${escapeHtml(detail.title || detail.taskName)}</h2>
          <span>${escapeHtml(detail.taskName)}</span>
        </div>
        <span class="task-detail-status ${escapeHtml(detail.status)}">${running ? 'Running' : escapeHtml(capitalize(detail.status))}</span>
      </div>
      <div class="task-detail-meta">
        ${detail.runId ? metaItem('Run', detail.runId.slice(0, 12)) : ''}
        ${origin ? metaItem('Origin', origin) : ''}
        ${detail.startedAt ? metaItem('Started', formatClock(detail.startedAt)) : ''}
        ${duration > 0 ? metaItem(running ? 'Elapsed' : 'Duration', formatDuration(duration), 'data-detail-elapsed') : ''}
      </div>
      ${input ? blockHtml('Input', input) : ''}
      <div class="task-detail-actions">
        ${running && detail.runId ? `<button type="button" class="btn compact danger" data-detail-stop>${ICON_STOP}<span>Stop</span></button>` : ''}
        <button type="button" class="btn compact ghost" data-copy-logs>Copy logs</button>
      </div>
      <div class="task-log-lines" data-role="logs">
        ${detail.logs.length > 0 ? detail.logs.map(renderLogLine).join('') : '<div class="task-log-empty">No log lines yet.</div>'}
      </div>
      ${detail.error ? blockHtml('Error', detail.error, 'is-error') : ''}
      ${result ? blockHtml('Result', result) : ''}
    </div>
  `
}

function renderLogLine(log: LogEntry): string {
  const level = String(log.level || 'log')
  return `
    <div class="task-log-line">
      <span class="task-log-ts">${escapeHtml(formatLogTime(log.timestamp))}</span>
      <span class="task-log-level ${escapeHtml(levelClass(level))}">${escapeHtml(levelLabel(level))}</span>
      <span class="task-log-msg">${escapeHtml(String(log.message ?? ''))}</span>
    </div>
  `
}

function blockHtml(label: string, value: string, extraClass = ''): string {
  return `
    <div class="task-detail-block ${extraClass}">
      <div class="task-detail-block-label">${escapeHtml(label)}</div>
      <pre>${escapeHtml(value)}</pre>
    </div>
  `
}

function metaItem(label: string, value: string, attr = ''): string {
  return `<div class="task-detail-meta-item"><span>${escapeHtml(label)}</span><strong ${attr}>${escapeHtml(value)}</strong></div>`
}

function detailFromRead(detail: TaskRunRead): LogDetail {
  return {
    runId: detail.runId,
    taskName: detail.taskName,
    title: detail.title || detail.taskName,
    status: detail.status,
    origin: detail.origin,
    input: detail.input,
    startedAt: detail.startedAt,
    finishedAt: detail.finishedAt,
    result: detail.result,
    error: detail.error,
    logs: Array.isArray(detail.logs) ? detail.logs : [],
  }
}

function detailFromLogFile(parsed: Record<string, unknown>, item: TaskLogHistoryItem): LogDetail {
  const taskName = stringValue(parsed.taskName) || item.taskName
  const title = stringValue(parsed.taskTitle) || taskName
  return {
    runId: stringValue(parsed.runId) || undefined,
    taskName,
    title,
    status: stringValue(parsed.status) || item.status,
    origin: isTaskOrigin(parsed.origin) ? parsed.origin : item.origin,
    input: parsed.input,
    startedAt: numberValue(parsed.startedAt) ?? undefined,
    finishedAt: numberValue(parsed.finishedAt) ?? item.updatedAt,
    result: parsed.result,
    error: stringValue(parsed.error),
    logs: Array.isArray(parsed.logs) ? parsed.logs.filter(isLogEntry) : [],
  }
}

function parseTaskRow(row: Record<string, unknown>): TaskItem | null {
  const name = stringValue(row.name)
  if (!name) return null
  return {
    name,
    title: stringValue(row.title) || name,
    description: stringValue(row.description) || '',
    timeout_ms: numberValue(row.timeout_ms),
  }
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.message === 'string'
}

function isTaskOrigin(value: unknown): value is TaskOrigin {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

function originLabel(origin?: TaskOrigin): string {
  if (!origin) return ''
  switch (origin.type) {
    case 'command-palette': return 'cmd'
    case 'task-panel': return 'panel'
    case 'agent': return 'agent'
    case 'trigger': return origin.triggerType
    case 'view': return 'view'
    case 'shortcut': return 'shortcut'
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatClock(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatLogTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function levelClass(level: string): string {
  const l = level.toLowerCase()
  if (l === 'error') return 'is-error'
  if (l === 'warn' || l === 'warning') return 'is-warn'
  if (l === 'info') return 'is-info'
  return ''
}

function levelLabel(level: string): string {
  const l = level.toLowerCase()
  if (l === 'error') return 'ERR'
  if (l === 'warn' || l === 'warning') return 'WRN'
  if (l === 'info') return 'INF'
  return 'LOG'
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
