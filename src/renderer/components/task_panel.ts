// Task types (mirrored from main process)
type TaskOrigin =
  | { type: 'command-palette' }
  | { type: 'task-panel' }
  | { type: 'agent' }
  | { type: 'trigger'; triggerName: string; triggerType: 'schedule' | 'http' | 'event'; triggerConfig?: string }
  | { type: 'view' }

interface TaskLogHistoryItem {
  file: string
  updatedAt: number
  taskName: string
  status: string
  origin?: TaskOrigin
}
import { escapeHtml } from './chat_utils.js'

interface TaskItem {
  name: string
  title: string
  description: string
  timeout_ms: number | null
}

interface TriggerItem {
  name: string
  task_name: string
  type: 'schedule' | 'http' | 'event'
  config: string
  description: string
  enabled: number
  task_title: string
}

interface LogDetail {
  status: string
  origin?: TaskOrigin
  startedAt?: number
  finishedAt?: number
  input?: unknown
  error?: string
  result?: unknown
  logs: Array<{ level: string; message: string; timestamp?: number }>
}

type ActiveTab = 'runs' | 'tasks' | 'triggers'

// Detail view can show a running task or a history entry
interface DetailView {
  type: 'running' | 'history'
  runId?: string
  file?: string
  taskName: string
  detail: LogDetail | null
}

const COPY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:12px;height:12px;flex-shrink:0;vertical-align:middle;"><rect x="5" y="2" width="9" height="11" rx="1.5"/><path d="M2 5.5v8a1.5 1.5 0 001.5 1.5h8"/></svg>'

const STYLES = `
  :host {
    display: flex;
    flex-direction: column;
    height: 100%;
    font-family: var(--font-family);
    color: var(--color-text3);
    overflow: hidden;
  }

  /* === HEADER & TABS === */
  .hdr { padding: 6px 12px 0; flex-shrink: 0; }
  .hdr-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .hdr-title { font-size: 13px; font-weight: 600; color: var(--color-text4); flex: 1; }
  .hdr-badge {
    font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 8px;
    background: var(--color-green-bg); color: var(--color-green-fg);
  }
  .hdr-badge.hidden { display: none; }
  .tabs { display: flex; border-bottom: 1px solid var(--color-border); }
  .tab {
    padding: 5px 0; margin-right: 16px;
    font-size: 11.5px; color: var(--color-text2); cursor: pointer;
    border: none; background: transparent; font-family: inherit;
    border-bottom: 2px solid transparent; transition: all 0.1s;
  }
  .tab:hover { color: var(--color-text3); }
  .tab.active { color: var(--color-text4); border-bottom-color: var(--color-accent); }

  .scroll { flex: 1; overflow-y: auto; padding: 4px 0; }
  .empty { font-size: 12px; color: var(--color-text1); padding: 12px; font-style: italic; text-align: center; }

  /* === RUNS TAB === */
  .rr {
    display: flex; align-items: center;
    padding: 6px 12px; gap: 8px;
    cursor: pointer; transition: background 0.08s;
    border-left: 3px solid var(--color-green-fg); margin: 2px 0;
  }
  .rr:hover { background: var(--color-item-hover); }
  .rr-pulse {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--color-green-fg); animation: pulse 2s ease-in-out infinite; flex-shrink: 0;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .rr-info { flex: 1; min-width: 0; }
  .rr-name { font-size: 12px; font-weight: 500; color: var(--color-text4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rr-sub { font-size: 10px; color: var(--color-text2); display: flex; gap: 5px; align-items: center; }
  .chip {
    font-size: 9px; font-family: var(--font-mono); font-weight: 600;
    text-transform: uppercase; padding: 0 5px; border-radius: 3px;
    background: var(--color-surface); color: var(--color-text2);
  }
  .rr-time { font-size: 11px; font-family: var(--font-mono); color: var(--color-green-fg); flex-shrink: 0; }
  .rr-stop {
    padding: 1px 6px; font-size: 10px; border-radius: 3px;
    border: 1px solid var(--color-red-fg); color: var(--color-red-fg);
    background: transparent; cursor: pointer; flex-shrink: 0; font-family: inherit;
  }
  .rr-stop:hover { background: var(--color-red-bg); }
  .rr-log {
    font-size: 10px; color: var(--color-text2); font-family: var(--font-mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
  }
  .rr-log .hi { color: var(--color-accent); font-weight: 600; }

  .sep { height: 1px; background: var(--color-divider); margin: 6px 12px; }
  .date-lbl { padding: 8px 12px 2px; font-size: 10px; font-weight: 600; color: var(--color-text2); }

  .hr {
    display: flex; align-items: center;
    padding: 5px 12px; gap: 8px;
    cursor: pointer; transition: background 0.08s;
  }
  .hr:hover { background: var(--color-item-hover); }
  .hr.failed { border-left: 3px solid var(--color-red-fg); }
  .hr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .hr-dot.ok { background: var(--color-green-fg); }
  .hr-dot.err { background: var(--color-red-fg); }
  .hr-info { flex: 1; min-width: 0; }
  .hr-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hr-sub { font-size: 10px; color: var(--color-text2); display: flex; gap: 5px; align-items: center; }
  .hr-sub .etxt { color: var(--color-red-fg); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hr-right { text-align: right; flex-shrink: 0; }
  .hr-dur { font-size: 10px; color: var(--color-text3); font-family: var(--font-mono); }
  .hr-ts { font-size: 9px; color: var(--color-text2); font-family: var(--font-mono); }

  /* === TASKS TAB === */
  .task-card {
    margin: 4px 8px; padding: 8px 10px;
    background: var(--color-bg2); border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px); transition: border-color 0.1s;
    cursor: pointer;
  }
  .task-card:hover { border-color: var(--color-text2); }
  .task-card.expanded { border-color: var(--color-accent); }
  .task-card-top { display: flex; align-items: center; gap: 8px; }
  .tc-name {
    flex: 1; font-size: 12.5px; font-weight: 500; color: var(--color-text4);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tc-run {
    padding: 2px 10px; font-size: 10px; border-radius: 3px;
    border: 1px solid var(--color-accent); color: var(--color-accent);
    background: transparent; cursor: pointer; font-family: inherit; flex-shrink: 0;
  }
  .tc-run:hover { background: var(--color-green-bg); }
  .tc-desc {
    font-size: 11px; color: var(--color-text2); line-height: 1.4; margin-top: 4px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .tc-footer {
    margin-top: 6px; display: flex; align-items: center; gap: 6px;
    font-size: 10px; color: var(--color-text2);
  }
  .tc-timeout { font-family: var(--font-mono); font-size: 10px; color: var(--color-text2); margin-left: auto; }
  .task-input-row { margin-top: 6px; display: flex; gap: 4px; }
  .run-input {
    flex: 1; min-width: 0; padding: 5px 8px; font-size: 11px;
    font-family: var(--font-mono);
    border: 1px solid var(--color-border); border-radius: var(--radius-sm, 4px);
    background: var(--color-bg1); color: var(--color-text3); outline: none;
  }
  .run-input:focus { border-color: var(--color-accent); }
  .run-input::placeholder { color: var(--color-text2); }
  .run-input-btn {
    padding: 4px 12px; font-size: 11px; border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--color-accent); color: var(--color-accent);
    background: transparent; cursor: pointer; font-family: inherit; flex-shrink: 0;
  }
  .run-input-btn:hover { background: var(--color-green-bg); }

  /* === TRIGGERS TAB === */
  .trig-card {
    margin: 4px 8px; padding: 8px 10px;
    background: var(--color-bg2); border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px); transition: border-color 0.1s;
  }
  .trig-card:hover { border-color: var(--color-text2); }
  .trig-card.disabled { opacity: 0.45; }
  .trig-top { display: flex; align-items: center; gap: 8px; }
  .tb {
    font-size: 9px; font-family: var(--font-mono); font-weight: 600; text-transform: uppercase;
    padding: 1px 6px; border-radius: 3px; flex-shrink: 0;
  }
  .tb-schedule { background: var(--color-green-bg); color: var(--color-accent); }
  .tb-http { background: var(--color-green-bg); color: var(--color-green-fg); }
  .tb-event { background: var(--color-yellow-bg); color: var(--color-yellow-fg); }
  .trig-name {
    flex: 1; font-size: 12.5px; font-weight: 500; color: var(--color-text4);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .trig-toggle {
    width: 28px; height: 16px; border-radius: 8px;
    background: var(--color-green-fg); position: relative; cursor: pointer;
    flex-shrink: 0; border: none;
  }
  .trig-toggle::after {
    content: ''; position: absolute; top: 2px; left: 14px;
    width: 12px; height: 12px; border-radius: 50%; background: #fff;
    transition: left 0.15s;
  }
  .trig-toggle.off { background: var(--color-border); }
  .trig-toggle.off::after { left: 2px; }
  .trig-desc { font-size: 11px; color: var(--color-text2); line-height: 1.4; margin-top: 4px; }
  .trig-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10px; }
  .trig-kv { display: flex; gap: 4px; }
  .trig-k { color: var(--color-text2); }
  .trig-v { color: var(--color-text3); font-family: var(--font-mono); }

  /* === LOG DETAIL VIEW === */
  .d-hdr {
    padding: 8px 10px; border-bottom: 1px solid var(--color-border);
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  }
  .d-back {
    width: 24px; height: 24px; border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--color-border); color: var(--color-text3); background: transparent;
    cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .d-back:hover { background: var(--color-item-hover); border-color: var(--color-text2); }
  .d-title {
    flex: 1; font-size: 13px; font-weight: 600; color: var(--color-text4);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .d-pill {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 2px 7px; border-radius: 8px; flex-shrink: 0;
  }
  .dp-running { background: var(--color-green-bg); color: var(--color-green-fg); }
  .dp-completed { background: var(--color-green-bg); color: var(--color-green-fg); }
  .dp-failed { background: var(--color-red-bg); color: var(--color-red-fg); }

  .d-meta {
    padding: 6px 12px;
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 2px 12px; font-size: 11px;
    border-bottom: 1px solid var(--color-divider); flex-shrink: 0;
  }
  .dm { display: flex; gap: 5px; }
  .dm-k { color: var(--color-text2); }
  .dm-v { color: var(--color-text3); font-family: var(--font-mono); }

  .d-input {
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-divider);
    flex-shrink: 0;
  }
  .d-input-label {
    font-size: 10px; color: var(--color-text2); margin-bottom: 3px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .d-input-value {
    font-family: var(--font-mono); font-size: 11px; line-height: 1.4;
    color: var(--color-text3); background: var(--color-bg3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px); padding: 4px 8px;
    white-space: pre-wrap; word-break: break-word;
    max-height: 60px; overflow-y: auto; user-select: text;
  }

  .d-actions {
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-divider);
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  }
  .d-btn {
    padding: 4px 10px; font-size: 11px; border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--color-border); color: var(--color-text3);
    background: transparent; cursor: pointer; font-family: inherit;
    display: flex; align-items: center; gap: 5px;
  }
  .d-btn:hover { background: var(--color-item-hover); border-color: var(--color-text2); }
  .d-btn.stop { border-color: var(--color-red-fg); color: var(--color-red-fg); }
  .d-btn.stop:hover { background: var(--color-red-bg); }
  .d-btn.copied { color: var(--color-green-fg); border-color: var(--color-green-fg); }
  .d-spacer { flex: 1; }
  .d-auto-scroll {
    font-size: 10px; color: var(--color-text2);
    display: flex; align-items: center; gap: 4px; cursor: pointer;
  }
  .d-auto-scroll input { accent-color: var(--color-accent); }

  .d-logs {
    flex: 1; overflow-y: auto;
    background: var(--color-bg3);
    font-family: var(--font-mono);
    font-size: 11px; line-height: 1.7;
    padding: 4px 0;
    user-select: text;
  }
  .ll {
    padding: 0 10px; display: flex; gap: 6px;
    white-space: pre-wrap; word-break: break-word;
  }
  .ll:hover { background: var(--color-item-hover); }
  .ll .ts { color: var(--color-text2); flex-shrink: 0; min-width: 56px; font-size: 10.5px; }
  .ll .lv { flex-shrink: 0; min-width: 30px; font-weight: 600; font-size: 10.5px; }
  .ll .ms { flex: 1; color: var(--color-text3); }
  .lv-info { color: var(--color-accent); }
  .lv-log { color: var(--color-text2); }
  .lv-warn { color: var(--color-yellow-fg); }
  .lv-error { color: var(--color-red-fg); }

  .d-result {
    border-top: 1px solid var(--color-divider);
    padding: 8px 12px; flex-shrink: 0;
  }
  .d-result-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--color-text2); margin-bottom: 4px; font-weight: 600;
  }
  .d-result-block {
    background: var(--color-bg3); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    padding: 6px 8px; font-family: var(--font-mono); font-size: 11px; line-height: 1.4;
    color: var(--color-text3); white-space: pre-wrap; word-break: break-word;
    max-height: 80px; overflow-y: auto; user-select: text;
  }
  .d-result-block.err { color: var(--color-red-fg); background: var(--color-red-bg); }
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

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatTimeShort(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTriggerConfig(type: string, config: string): Record<string, string> {
  try {
    const parsed = JSON.parse(config)
    switch (type) {
      case 'schedule': return { schedule: parsed.expression || '' }
      case 'http': return { method: (parsed.method || 'POST').toUpperCase(), path: parsed.path || '' }
      case 'event': return { topic: parsed.topic || '' }
      default: return {}
    }
  } catch {
    return {}
  }
}

function getDateLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const itemDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (itemDate.getTime() === today.getTime()) return 'Today'
  if (itemDate.getTime() === yesterday.getTime()) return 'Yesterday'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function logLevelClass(level: string): string {
  const l = level.toLowerCase()
  if (l === 'info') return 'lv-info'
  if (l === 'warn' || l === 'warning') return 'lv-warn'
  if (l === 'error') return 'lv-error'
  return 'lv-log'
}

function logLevelLabel(level: string): string {
  const l = level.toLowerCase()
  if (l === 'info') return 'INF'
  if (l === 'warn' || l === 'warning') return 'WRN'
  if (l === 'error') return 'ERR'
  return 'LOG'
}

function formatInputValue(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  return JSON.stringify(input, null, 2)
}

export class TlTaskPanel extends HTMLElement {
  private shadow: ShadowRoot
  private tasks: TaskItem[] = []
  private triggers: TriggerItem[] = []
  private logHistory: TaskLogHistoryItem[] = []
  private activeTab: ActiveTab = 'runs'
  private expandedTaskName: string | null = null
  private detailView: DetailView | null = null
  private detailAutoScroll = true
  private activeRuns: Array<{ runId: string; taskName: string; title: string; status: string; origin: TaskOrigin; startedAt: number }> = []
  private runFinishedUnsub: (() => void) | null = null
  private runningTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
  }

  connectedCallback() {
    this.shadow.innerHTML = `<style>${STYLES}</style><div id="root" style="display:flex;flex-direction:column;height:100%;overflow:hidden;"></div>`
    this.updateContent()
    this.loadTasks()
    this.loadTriggers()
    this.loadLogHistory()
    this.loadRunningTasks()

    this.runFinishedUnsub = window.ipc?.tasks.onRunFinished(() => {
      this.loadRunningTasks()
      this.loadLogHistory()
    }) ?? null

    this.runningTimer = setInterval(() => {
      if (this.activeRuns.length > 0) {
        this.updateRunTimers()
      }
    }, 1000)

    window.addEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.addEventListener('agentwfy:triggers-db-changed', this.onTriggersChanged)
    window.addEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)
    window.addEventListener('agentwfy:agent-switched', this.onAgentSwitched)
  }

  disconnectedCallback() {
    this.runFinishedUnsub?.()
    this.runFinishedUnsub = null
    if (this.runningTimer) {
      clearInterval(this.runningTimer)
      this.runningTimer = null
    }
    window.removeEventListener('agentwfy:tasks-db-changed', this.onTasksChanged)
    window.removeEventListener('agentwfy:triggers-db-changed', this.onTriggersChanged)
    window.removeEventListener('agentwfy:run-task', this.onRunTaskEvent as EventListener)
    window.removeEventListener('agentwfy:agent-switched', this.onAgentSwitched)
  }

  private onTasksChanged = () => { this.loadTasks() }
  private onTriggersChanged = () => { this.loadTriggers() }
  private onAgentSwitched = () => {
    this.detailView = null
    this.loadTasks()
    this.loadTriggers()
    this.loadLogHistory()
    this.loadRunningTasks()
  }

  private onRunTaskEvent = (e: CustomEvent<{ taskName: string; input?: string }>) => {
    const taskName = e.detail?.taskName
    if (typeof taskName === 'string' && taskName) {
      const ipc = window.ipc
      if (ipc) {
        const input = e.detail?.input
        ipc.tasks.start(taskName, input || undefined, { type: 'command-palette' } as any).then(() => {
          this.loadRunningTasks()
        }).catch(err => {
          console.error('[TlTaskPanel] run task failed', err)
        })
      }
    }
  }

  private async loadTasks() {
    const ipc = window.ipc
    if (!ipc) return
    try {
      const rows = await ipc.sql.run({
        target: 'agent',
        sql: 'SELECT name, title, description, timeout_ms FROM tasks ORDER BY title ASC',
      }) as TaskItem[]
      this.tasks = Array.isArray(rows) ? rows : []
    } catch { this.tasks = [] }
    this.updateContent()
  }

  private async loadTriggers() {
    const ipc = window.ipc
    if (!ipc) return
    try {
      const rows = await ipc.sql.run({
        target: 'agent',
        sql: `SELECT t.name, t.task_name, t.type, t.config, t.description, t.enabled, k.title as task_title
              FROM triggers t LEFT JOIN tasks k ON t.task_name = k.name
              ORDER BY t.enabled DESC, k.title ASC`,
      }) as TriggerItem[]
      this.triggers = Array.isArray(rows) ? rows : []
    } catch { this.triggers = [] }
    this.updateContent()
  }

  private async loadRunningTasks() {
    const ipc = window.ipc
    if (!ipc) return
    try {
      this.activeRuns = await ipc.tasks.listRunning() as typeof this.activeRuns
    } catch { this.activeRuns = [] }
    this.updateContent()
  }

  private async loadLogHistory() {
    const ipc = window.ipc
    if (!ipc) return
    try {
      this.logHistory = await ipc.tasks.listLogHistory() as TaskLogHistoryItem[]
    } catch { this.logHistory = [] }
    this.updateContent()
  }

  private updateContent() {
    const root = this.shadow.querySelector('#root')
    if (!root) return

    if (this.detailView) {
      root.innerHTML = this.renderDetailView()
      this.attachDetailListeners()
      if (this.detailAutoScroll) {
        const logArea = this.shadow.querySelector('.d-logs')
        if (logArea) logArea.scrollTop = logArea.scrollHeight
      }
    } else {
      root.innerHTML = this.renderListView()
      this.attachListListeners()
    }
  }

  // ==========================================
  // LIST VIEW
  // ==========================================

  private renderListView(): string {
    const runCount = this.activeRuns.length
    let html = ''

    html += `<div class="hdr">
      <div class="tabs">
        <button class="tab${this.activeTab === 'runs' ? ' active' : ''}" data-tab="runs">Runs${runCount > 0 ? ' (' + runCount + ')' : ''}</button>
        <button class="tab${this.activeTab === 'tasks' ? ' active' : ''}" data-tab="tasks">Tasks</button>
        <button class="tab${this.activeTab === 'triggers' ? ' active' : ''}" data-tab="triggers">Triggers</button>
      </div>
    </div>`

    html += '<div class="scroll">'
    switch (this.activeTab) {
      case 'runs': html += this.renderRunsTab(); break
      case 'tasks': html += this.renderTasksTab(); break
      case 'triggers': html += this.renderTriggersTab(); break
    }
    html += '</div>'
    return html
  }

  private renderRunsTab(): string {
    let html = ''

    // Running tasks
    for (const run of this.activeRuns) {
      const elapsed = Date.now() - run.startedAt
      const oLabel = originLabel(run.origin)
      html += `<div class="rr" data-detail-run="${escapeHtml(run.runId)}">
        <div class="rr-pulse"></div>
        <div class="rr-info">
          <div class="rr-name">${escapeHtml(run.title)}</div>
          <div class="rr-sub">${oLabel ? `<span class="chip">${escapeHtml(oLabel)}</span>` : ''} ${escapeHtml(run.runId.slice(0, 12))}</div>
        </div>
        <span class="rr-time">${formatElapsed(elapsed)}</span>
        <button class="rr-stop" data-stop-run="${escapeHtml(run.runId)}">Stop</button>
      </div>`
    }

    if (this.activeRuns.length > 0 && this.logHistory.length > 0) {
      html += '<div class="sep"></div>'
    }

    // History grouped by date
    let lastDateLabel = ''
    for (const item of this.logHistory) {
      const dl = getDateLabel(item.updatedAt)
      if (dl !== lastDateLabel) {
        lastDateLabel = dl
        html += `<div class="date-lbl">${escapeHtml(dl)}</div>`
      }
      const isFailed = item.status === 'failed'
      const oLabel = originLabel(item.origin)
      html += `<div class="hr${isFailed ? ' failed' : ''}" data-detail-file="${escapeHtml(item.file)}">
        <div class="hr-dot ${isFailed ? 'err' : 'ok'}"></div>
        <div class="hr-info">
          <div class="hr-name">${escapeHtml(item.taskName)}</div>
          <div class="hr-sub">${oLabel ? `<span class="chip">${escapeHtml(oLabel)}</span>` : ''}</div>
        </div>
        <div class="hr-right">
          <div class="hr-dur">${formatTimeShort(item.updatedAt)}</div>
        </div>
      </div>`
    }

    if (this.activeRuns.length === 0 && this.logHistory.length === 0) {
      html += '<div class="empty">No runs yet</div>'
    }

    return html
  }

  private renderTasksTab(): string {
    if (this.tasks.length === 0) return '<div class="empty">No tasks defined</div>'

    let html = ''
    for (const task of this.tasks) {
      const isExpanded = this.expandedTaskName === task.name
      const taskTriggers = this.triggers.filter(t => t.task_name === task.name && t.enabled)
      html += `<div class="task-card${isExpanded ? ' expanded' : ''}" data-task-name="${escapeHtml(task.name)}">
        <div class="task-card-top">
          <span class="tc-name">${escapeHtml(task.title)}</span>
          <button class="tc-run" data-run-task="${escapeHtml(task.name)}">Run</button>
        </div>`
      if (task.description) {
        html += `<div class="tc-desc">${escapeHtml(task.description)}</div>`
      }
      if (taskTriggers.length > 0 || task.timeout_ms) {
        html += '<div class="tc-footer">'
        for (const t of taskTriggers) {
          html += `<span class="chip">${escapeHtml(t.type)}</span>`
        }
        if (task.timeout_ms) {
          html += `<span class="tc-timeout">timeout: ${formatElapsed(task.timeout_ms)}</span>`
        }
        html += '</div>'
      }
      if (isExpanded) {
        html += `<div class="task-input-row">
          <input class="run-input" data-input-task="${escapeHtml(task.name)}" placeholder="Input (optional)..." />
          <button class="run-input-btn" data-run-task-input="${escapeHtml(task.name)}">Run</button>
        </div>`
      }
      html += '</div>'
    }
    return html
  }

  private renderTriggersTab(): string {
    if (this.triggers.length === 0) return '<div class="empty">No triggers defined</div>'

    let html = ''
    for (const trigger of this.triggers) {
      const disabled = !trigger.enabled
      const taskName = trigger.task_title || trigger.task_name
      const configKV = formatTriggerConfig(trigger.type, trigger.config)

      html += `<div class="trig-card${disabled ? ' disabled' : ''}">
        <div class="trig-top">
          <span class="tb tb-${escapeHtml(trigger.type)}">${escapeHtml(trigger.type)}</span>
          <span class="trig-name">${escapeHtml(taskName)}</span>
          <button class="trig-toggle${disabled ? ' off' : ''}" data-trigger-toggle="${escapeHtml(trigger.name)}"></button>
        </div>`
      if (trigger.description) {
        html += `<div class="trig-desc">${escapeHtml(trigger.description)}</div>`
      }
      const entries = Object.entries(configKV)
      if (entries.length > 0) {
        html += '<div class="trig-meta">'
        for (const [k, v] of entries) {
          html += `<div class="trig-kv"><span class="trig-k">${escapeHtml(k)}</span><span class="trig-v">${escapeHtml(v)}</span></div>`
        }
        html += `<div class="trig-kv"><span class="trig-k">task</span><span class="trig-v">${escapeHtml(taskName)}</span></div>`
        html += '</div>'
      }
      html += '</div>'
    }
    return html
  }

  // ==========================================
  // DETAIL VIEW
  // ==========================================

  private renderDetailView(): string {
    const dv = this.detailView!
    const detail = dv.detail
    const status = detail?.status || 'running'
    const oLabel = detail?.origin ? originLabel(detail.origin) : ''
    const startedAt = detail?.startedAt
    const isRunning = dv.type === 'running'
    const elapsed = isRunning && startedAt ? Date.now() - startedAt : (detail?.finishedAt && startedAt ? detail.finishedAt - startedAt : 0)
    const inputStr = detail?.input !== null && detail?.input !== undefined ? formatInputValue(detail.input) : ''

    let html = `<div class="d-hdr">
      <button class="d-back">←</button>
      <span class="d-title">${escapeHtml(dv.taskName)}</span>
      <span class="d-pill dp-${escapeHtml(status)}">${isRunning ? '● ' : ''}${escapeHtml(status.charAt(0).toUpperCase() + status.slice(1))}</span>
    </div>`

    html += '<div class="d-meta">'
    if (dv.runId) html += `<div class="dm"><span class="dm-k">Run</span><span class="dm-v">${escapeHtml(dv.runId.slice(0, 12))}</span></div>`
    if (oLabel) html += `<div class="dm"><span class="dm-k">Origin</span><span class="dm-v">${escapeHtml(oLabel)}</span></div>`
    if (startedAt) html += `<div class="dm"><span class="dm-k">Started</span><span class="dm-v">${formatTime(startedAt)}</span></div>`
    if (elapsed > 0) {
      const elStyle = isRunning ? ' style="color:var(--color-green-fg)"' : (status === 'failed' ? ' style="color:var(--color-red-fg)"' : '')
      html += `<div class="dm"><span class="dm-k">${isRunning ? 'Elapsed' : 'Duration'}</span><span class="dm-v"${elStyle}>${formatElapsed(elapsed)}</span></div>`
    }
    html += '</div>'

    if (inputStr) {
      html += `<div class="d-input">
        <div class="d-input-label">Input</div>
        <div class="d-input-value">${escapeHtml(inputStr)}</div>
      </div>`
    }

    html += `<div class="d-actions">
      ${isRunning ? '<button class="d-btn stop" data-detail-stop>■ Stop</button>' : ''}
      <button class="d-btn" data-copy-logs>${COPY_SVG} Copy</button>
      <span class="d-spacer"></span>
      ${isRunning ? `<label class="d-auto-scroll"><input type="checkbox" data-auto-scroll ${this.detailAutoScroll ? 'checked' : ''} /> Tail</label>` : ''}
    </div>`

    // Logs
    html += '<div class="d-logs">'
    if (detail && detail.logs) {
      for (const log of detail.logs) {
        const ts = log.timestamp ? formatTime(log.timestamp) : ''
        const lvCls = logLevelClass(log.level)
        const lvLabel = logLevelLabel(log.level)
        html += `<div class="ll"><span class="ts">${ts}</span><span class="lv ${lvCls}">${lvLabel}</span><span class="ms">${escapeHtml(log.message)}</span></div>`
      }
    }
    html += '</div>'

    // Result or Error at bottom
    if (detail?.error) {
      html += `<div class="d-result">
        <div class="d-result-label">Error</div>
        <div class="d-result-block err">${escapeHtml(detail.error)}</div>
      </div>`
    } else if (detail?.result !== null && detail?.result !== undefined) {
      const resultStr = typeof detail.result === 'string' ? detail.result : JSON.stringify(detail.result, null, 2)
      html += `<div class="d-result">
        <div class="d-result-label">Result</div>
        <div class="d-result-block">${escapeHtml(resultStr)}</div>
      </div>`
    }

    return html
  }

  // ==========================================
  // LISTENERS
  // ==========================================

  private attachListListeners() {
    // Tab switching
    this.shadow.querySelectorAll('.tab[data-tab]').forEach(el => {
      el.addEventListener('click', () => {
        this.activeTab = (el as HTMLElement).dataset.tab as ActiveTab
        this.updateContent()
      })
    })

    // Click running task -> detail
    this.shadow.querySelectorAll('[data-detail-run]').forEach(el => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.rr-stop')) return
        const runId = (el as HTMLElement).dataset.detailRun!
        const run = this.activeRuns.find(r => r.runId === runId)
        if (run) this.openRunningDetail(run)
      })
    })

    // Click history -> detail
    this.shadow.querySelectorAll('[data-detail-file]').forEach(el => {
      el.addEventListener('click', () => {
        const file = (el as HTMLElement).dataset.detailFile!
        const item = this.logHistory.find(h => h.file === file)
        if (item) this.openHistoryDetail(item)
      })
    })

    // Stop running task
    this.shadow.querySelectorAll('[data-stop-run]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const runId = (btn as HTMLElement).dataset.stopRun!
        window.ipc?.tasks.stop(runId).catch(() => {})
      })
    })

    // Task card expand/collapse
    this.shadow.querySelectorAll('.task-card[data-task-name]').forEach(el => {
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.tc-run') || (e.target as HTMLElement).closest('.run-input') || (e.target as HTMLElement).closest('.run-input-btn')) return
        const taskName = (el as HTMLElement).dataset.taskName!
        this.expandedTaskName = this.expandedTaskName === taskName ? null : taskName
        this.updateContent()
      })
    })

    // Run button — runs task immediately (no input)
    this.shadow.querySelectorAll('.tc-run[data-run-task]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const taskName = (btn as HTMLElement).dataset.runTask!
        this.runWithInput(taskName)
      })
    })

    // Run with input
    this.shadow.querySelectorAll('[data-run-task-input]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const taskName = (btn as HTMLElement).dataset.runTaskInput!
        this.runWithInput(taskName)
      })
    })

    // Enter on input
    this.shadow.querySelectorAll('.run-input[data-input-task]').forEach(el => {
      el.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          e.preventDefault()
          const taskName = (el as HTMLInputElement).dataset.inputTask!
          this.runWithInput(taskName)
        }
      })
    })

    // Focus input if expanded
    if (this.expandedTaskName !== null) {
      const inputEl = this.shadow.querySelector(`.run-input[data-input-task="${this.expandedTaskName}"]`) as HTMLInputElement | null
      if (inputEl && !inputEl.value) inputEl.focus()
    }
  }

  private attachDetailListeners() {
    // Back button
    this.shadow.querySelector('.d-back')?.addEventListener('click', () => {
      this.detailView = null
      this.updateContent()
    })

    // Stop button
    this.shadow.querySelector('[data-detail-stop]')?.addEventListener('click', () => {
      if (this.detailView?.runId) {
        window.ipc?.tasks.stop(this.detailView.runId).catch(() => {})
      }
    })

    // Copy logs
    this.shadow.querySelector('[data-copy-logs]')?.addEventListener('click', () => {
      const detail = this.detailView?.detail
      if (!detail?.logs) return
      const text = detail.logs.map(l => {
        const ts = l.timestamp ? formatTime(l.timestamp) : ''
        return `${ts} [${l.level}] ${l.message}`
      }).join('\n')
      navigator.clipboard.writeText(text).then(() => {
        const btn = this.shadow.querySelector('[data-copy-logs]') as HTMLElement
        if (btn) {
          btn.classList.add('copied')
          btn.innerHTML = `${COPY_SVG} Copied!`
          setTimeout(() => {
            btn.classList.remove('copied')
            btn.innerHTML = `${COPY_SVG} Copy`
          }, 1500)
        }
      }).catch(() => {})
    })

    // Auto-scroll toggle
    this.shadow.querySelector('[data-auto-scroll]')?.addEventListener('change', (e) => {
      this.detailAutoScroll = (e.target as HTMLInputElement).checked
    })
  }

  // ==========================================
  // ACTIONS
  // ==========================================

  private runWithInput(taskName: string) {
    if (!taskName) return
    const inputEl = this.shadow.querySelector(`.run-input[data-input-task="${taskName}"]`) as HTMLInputElement | null
    const inputValue = inputEl?.value?.trim() || undefined
    const ipc = window.ipc
    if (ipc) {
      ipc.tasks.start(taskName, inputValue, { type: 'task-panel' } as any).then(() => {
        this.loadRunningTasks()
        this.activeTab = 'runs'
        this.expandedTaskName = null
        this.updateContent()
      }).catch(err => console.error('[TlTaskPanel] run failed', err))
      if (inputEl) inputEl.value = ''
    }
  }

  private openRunningDetail(run: typeof this.activeRuns[0]) {
    this.detailView = {
      type: 'running',
      runId: run.runId,
      taskName: run.title,
      detail: {
        status: 'running',
        origin: run.origin,
        startedAt: run.startedAt,
        logs: [],
      },
    }
    this.updateContent()
    // Note: live log streaming for running tasks would require additional IPC
    // For now the detail shows metadata; logs appear when the task finishes
  }

  private async openHistoryDetail(item: TaskLogHistoryItem) {
    this.detailView = {
      type: 'history',
      file: item.file,
      taskName: item.taskName,
      detail: null,
    }
    this.updateContent()

    const ipc = window.ipc
    if (!ipc) return

    try {
      const raw = await ipc.tasks.readLog(item.file)
      const parsed = JSON.parse(raw)
      this.detailView!.detail = {
        status: parsed.status || item.status,
        origin: parsed.origin as TaskOrigin,
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        input: parsed.input,
        error: parsed.error,
        result: parsed.result,
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      }
      if (parsed.origin?.type === 'trigger' && parsed.origin?.triggerConfig) {
        // already in origin
      }
    } catch {
      this.detailView!.detail = {
        status: 'failed',
        logs: [{ level: 'error', message: 'Failed to load log file' }],
      }
    }
    this.updateContent()
  }

  private updateRunTimers() {
    // Update elapsed times in list view
    if (!this.detailView) {
      const spans = this.shadow.querySelectorAll('.rr-time')
      spans.forEach((el, i) => {
        if (i < this.activeRuns.length) {
          el.textContent = formatElapsed(Date.now() - this.activeRuns[i].startedAt)
        }
      })
    }
    // Update elapsed in detail view for running task
    if (this.detailView?.type === 'running' && this.detailView.detail?.startedAt) {
      const el = this.shadow.querySelector('.dm-v[style]')
      if (el) {
        el.textContent = formatElapsed(Date.now() - this.detailView.detail.startedAt)
      }
    }
  }
}
