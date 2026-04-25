import { escapeHtml, copyToButton, CLOSE_ICON_SVG, BACK_ICON_SVG } from './chat_utils.js'
import type { TraceEvent, TraceExecEvent, TraceCallEvent } from '../ipc-types/index.js'

interface ExecGroup {
  exec: TraceExecEvent | null
  execId: string
  index: number
  calls: TraceCallEvent[]
  startedAt: number
  endedAt: number
  hasError: boolean
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) + 's'
}

function formatTime(ts: number, base: number): string {
  const delta = ts - base
  if (delta < 1) return '+0ms'
  if (delta < 1000) return '+' + Math.round(delta) + 'ms'
  return '+' + (delta / 1000).toFixed(2) + 's'
}

function shortenMethod(method: string): string {
  return method.length > 26 ? method.slice(0, 25) + '…' : method
}

function execHeaderText(exec: TraceExecEvent | null): string {
  if (!exec) return '(exec missing)'
  const desc = exec.description.trim()
  if (desc) return desc.length > 140 ? desc.slice(0, 139) + '…' : desc
  const firstNonEmpty = exec.code.split('\n').find(l => l.trim().length > 0) ?? exec.code
  const line = firstNonEmpty.trim()
  return line.length > 140 ? line.slice(0, 139) + '…' : line
}

function clampPct(v: number): string {
  return Math.max(0, Math.min(100, v)).toFixed(2)
}

function groupEvents(events: TraceEvent[]): { groups: ExecGroup[]; totalStart: number; totalEnd: number; totalErrors: number } {
  const byExecId = new Map<string, ExecGroup>()

  for (const ev of events) {
    if (ev.t === 'exec') {
      const prev = byExecId.get(ev.id)
      if (prev) {
        prev.exec = ev
        prev.startedAt = Math.min(prev.startedAt, ev.startedAt)
        prev.endedAt = Math.max(prev.endedAt, ev.startedAt + ev.durationMs)
        if (!ev.ok) prev.hasError = true
      } else {
        byExecId.set(ev.id, {
          exec: ev,
          execId: ev.id,
          index: 0,
          calls: [],
          startedAt: ev.startedAt,
          endedAt: ev.startedAt + ev.durationMs,
          hasError: !ev.ok,
        })
      }
    }
  }

  for (const ev of events) {
    if (ev.t === 'call') {
      let group = byExecId.get(ev.execId)
      if (!group) {
        group = {
          exec: null,
          execId: ev.execId,
          index: 0,
          calls: [],
          startedAt: ev.startedAt,
          endedAt: ev.startedAt + ev.durationMs,
          hasError: false,
        }
        byExecId.set(ev.execId, group)
      }
      group.calls.push(ev)
      if (group.startedAt === 0 || ev.startedAt < group.startedAt) {
        group.startedAt = ev.startedAt
      }
      const callEnd = ev.startedAt + ev.durationMs
      if (callEnd > group.endedAt) group.endedAt = callEnd
      if (!ev.ok) group.hasError = true
    }
  }

  const groups = Array.from(byExecId.values())
  for (const g of groups) g.calls.sort((a, b) => a.startedAt - b.startedAt)
  groups.sort((a, b) => a.startedAt - b.startedAt)
  groups.forEach((g, i) => { g.index = i + 1 })

  let totalStart = Infinity
  let totalEnd = 0
  let totalErrors = 0
  for (const g of groups) {
    totalStart = Math.min(totalStart, g.startedAt)
    totalEnd = Math.max(totalEnd, g.endedAt)
    if (g.hasError) totalErrors++
  }
  if (!isFinite(totalStart)) totalStart = 0

  return { groups, totalStart, totalEnd, totalErrors }
}

function formatJsonMaybe(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return text
  const first = trimmed[0]
  if (first !== '{' && first !== '[' && first !== '"') return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

const STYLES = `
  awfy-trace-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    animation: tr-fade 140ms ease-out;
  }
  awfy-trace-panel[hidden] { display: none; }
  @keyframes tr-fade { from { opacity: 0; } to { opacity: 1; } }

  /* Shared atoms */
  .tr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
  .tr-dot.ok  { background: var(--color-green-fg); }
  .tr-dot.err { background: var(--color-red-fg); }

  .tr-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--color-text2);
    line-height: 1;
  }
  .tr-status.ok  { color: var(--color-text2); }
  .tr-status.err { color: var(--color-red-fg); }
  .tr-status .tr-dot { background: currentColor; }
  .tr-status.ok .tr-dot { background: var(--color-green-fg); }

  .tr-icon-btn {
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--color-text2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
    border-radius: 4px;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tr-icon-btn:hover { background: var(--color-item-hover); color: var(--color-text4); }
  .tr-icon-btn svg { display: block; }

  /* List view header */
  .tr-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 12px;
    border-bottom: 1px solid var(--color-divider);
    flex-shrink: 0;
    min-height: 28px;
  }
  .tr-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text4);
    letter-spacing: -0.1px;
    flex-shrink: 0;
  }
  .tr-stats {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
  }
  .tr-stats span { white-space: nowrap; }
  .tr-stats .n { color: var(--color-text3); }
  .tr-stats .sep { opacity: 0.5; }

  .tr-filters {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 12px 6px;
    border-bottom: 1px solid var(--color-divider);
    flex-shrink: 0;
  }
  .tr-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    padding: 0;
    border-radius: 0;
    font-size: 11px;
    color: var(--color-text2);
    background: transparent;
    border: none;
    cursor: pointer;
    user-select: none;
    transition: color var(--transition-fast);
    line-height: 1.4;
  }
  .tr-chip:hover { color: var(--color-text4); }
  .tr-chip.active {
    color: var(--color-text4);
    font-weight: 600;
    background: transparent;
    border: none;
  }
  .tr-chip.err.active { color: var(--color-red-fg); }
  .tr-chip-count {
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
    font-weight: 400;
  }
  .tr-chip.active .tr-chip-count { color: var(--color-text2); }

  .tr-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    user-select: text;
  }
  .tr-list { padding: 2px 0 12px; }

  .tr-exec {
    border-bottom: 1px solid var(--color-divider);
    background: transparent;
    overflow: hidden;
  }
  .tr-exec:last-child { border-bottom: none; }

  .tr-exec-head {
    padding: 7px 12px 7px 10px;
    cursor: pointer;
    user-select: none;
    transition: background var(--transition-fast);
  }
  .tr-exec-head:hover { background: var(--color-item-hover); }

  .tr-exec-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .tr-caret {
    color: var(--color-text2);
    font-size: 9px;
    width: 8px;
    flex-shrink: 0;
    transition: transform 120ms ease;
    text-align: center;
    opacity: 0.6;
  }
  .tr-exec.collapsed .tr-caret { transform: rotate(-90deg); }
  .tr-exec-desc {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: -0.1px;
  }
  .tr-exec.errored .tr-exec-desc { color: var(--color-text4); }
  .tr-exec-dur {
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
  }

  .tr-wf {
    position: relative;
    height: 4px;
    background: var(--color-bg3);
    border-radius: 2px;
    overflow: hidden;
    margin-left: 14px;
  }
  .tr-wf > i {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--color-text3);
    border-radius: 2px;
    min-width: 2px;
    opacity: 0.55;
  }
  .tr-wf > i.err { background: var(--color-red-fg); opacity: 0.9; }

  .tr-exec-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--color-text2);
    margin-top: 4px;
    margin-left: 14px;
    font-variant-numeric: tabular-nums;
  }
  .tr-exec-meta .sep { opacity: 0.5; }

  .tr-calls {
    background: transparent;
    padding: 0 0 6px;
  }
  .tr-exec.collapsed .tr-calls { display: none; }

  .tr-call {
    display: grid;
    grid-template-columns: minmax(60px, 1fr) minmax(36px, 1.5fr) auto 10px;
    gap: 10px;
    align-items: center;
    padding: 4px 12px 4px 32px;
    border: none;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .tr-call:hover { background: var(--color-item-hover); }
  .tr-call-method {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr-call.errored .tr-call-method { color: var(--color-red-fg); }
  .tr-mini {
    position: relative;
    height: 3px;
    background: var(--color-bg3);
    border-radius: 2px;
    overflow: hidden;
  }
  .tr-mini > i {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--color-text3);
    border-radius: 2px;
    min-width: 2px;
    opacity: 0.55;
  }
  .tr-call.errored .tr-mini > i { background: var(--color-red-fg); opacity: 0.9; }
  .tr-call-dur {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .tr-chev {
    color: var(--color-text2);
    font-size: 11px;
    opacity: 0;
    text-align: right;
    transition: opacity var(--transition-fast);
  }
  .tr-call:hover .tr-chev { opacity: 0.6; }

  /* Detail view */
  .tr-det-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--color-divider);
    flex-shrink: 0;
    min-height: 28px;
  }
  .tr-back {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11.5px;
    color: var(--color-text2);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 4px;
    font-family: var(--font-family);
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tr-back:hover { background: var(--color-item-hover); color: var(--color-text4); }
  .tr-back svg { display: block; }
  .tr-det-method {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text4);
    margin-left: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .tr-det-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px 14px;
    user-select: text;
    scrollbar-gutter: stable;
  }

  .tr-det-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text3);
    margin-bottom: 10px;
    letter-spacing: -0.05px;
    line-height: 1.4;
  }

  .tr-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 14px;
    font-size: 11px;
    color: var(--color-text2);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
  }
  .tr-badges .tr-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .tr-badges .tr-meta-item.ok  { color: var(--color-text2); }
  .tr-badges .tr-meta-item.err { color: var(--color-red-fg); }
  .tr-badges .tr-meta-item .tr-dot { width: 6px; height: 6px; }
  .tr-badges .tr-meta-item.ok .tr-dot { background: var(--color-green-fg); }
  .tr-badges .tr-meta-sep {
    color: var(--color-text2);
    opacity: 0.5;
  }

  .tr-error-card {
    margin: 0 0 14px;
    padding: 7px 10px;
    background: var(--color-red-bg);
    border-left: 2px solid var(--color-red-fg);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .tr-error-card .name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-red-fg);
    margin-bottom: 2px;
  }
  .tr-error-card .msg {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-red-fg);
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
    opacity: 0.9;
  }

  .tr-section { margin-bottom: 12px; }
  .tr-section h5 {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text2);
    line-height: 1.3;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .tr-section h5 .side {
    margin-left: auto;
    display: inline-flex;
    gap: 8px;
    align-items: baseline;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }
  .tr-section:hover h5 .side,
  .tr-section:focus-within h5 .side {
    opacity: 1;
  }
  .tr-section h5 .side .tr-trunc-pill { opacity: 1; }
  .tr-section pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--color-text4);
    background: var(--color-bg2);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border: none;
  }

  .tr-trunc-pill {
    font-size: 10px;
    font-weight: 400;
    color: var(--color-text2);
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-style: italic;
  }

  .tr-copy {
    font-size: 11px;
    color: var(--color-text2);
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    cursor: pointer;
    font-family: var(--font-family);
    line-height: 1.3;
    transition: color var(--transition-fast);
  }
  .tr-copy:hover { color: var(--color-text4); }
  .tr-copy.copied { color: var(--color-green-fg); }

  .tr-empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 8px;
    color: var(--color-text2);
    padding: 24px;
    text-align: center;
  }
  .tr-empty-title { font-size: 13px; font-weight: 600; color: var(--color-text3); }
  .tr-empty-sub { font-size: 11.5px; }
  .tr-loading {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text2);
    font-size: 12px;
  }
`

type TraceLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'
type ViewState = 'list' | 'detail'
type Filter = 'all' | 'errors'

export class TlTracePanel extends HTMLElement {
  private styleEl!: HTMLStyleElement
  private bodyHost!: HTMLElement

  private sessionId: string | null = null
  private sessionLabel = ''
  private events: TraceEvent[] = []
  private groups: ExecGroup[] = []
  private totalStart = 0
  private totalEnd = 0
  private totalErrors = 0
  private status: TraceLoadStatus = 'idle'
  private errorMessage = ''
  private expandedExecIds = new Set<string>()
  private filter: Filter = 'all'
  private view: ViewState = 'list'
  private selectedCallId: string | null = null
  private listScrollTop = 0

  connectedCallback() {
    this.hidden = true
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = STYLES
    this.appendChild(this.styleEl)

    this.bodyHost = document.createElement('div')
    this.bodyHost.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;'
    this.bodyHost.addEventListener('click', this.onCardClick)
    this.appendChild(this.bodyHost)

    document.addEventListener('keydown', this.onKeydown, true)
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.onKeydown, true)
  }

  async open(sessionId: string, sessionLabel: string): Promise<void> {
    const wasHidden = this.hidden
    this.sessionId = sessionId
    this.sessionLabel = sessionLabel
    this.hidden = false
    this.status = 'loading'
    this.events = []
    this.groups = []
    this.selectedCallId = null
    this.view = 'list'
    this.filter = 'all'
    this.listScrollTop = 0
    this.renderAll()
    if (wasHidden) this.dispatchEvent(new CustomEvent('open', { bubbles: true }))

    const ipc = window.ipc
    if (!ipc?.traces) {
      this.status = 'error'
      this.errorMessage = 'Trace API not available'
      this.renderAll()
      return
    }

    try {
      const events = await ipc.traces.list(sessionId)
      if (this.sessionId !== sessionId) return
      this.events = events
      const grouped = groupEvents(events)
      this.groups = grouped.groups
      this.totalStart = grouped.totalStart
      this.totalEnd = grouped.totalEnd
      this.totalErrors = grouped.totalErrors
      this.expandedExecIds = new Set(this.groups.map(g => g.execId))
      this.status = 'loaded'
      this.renderAll()
    } catch (err) {
      this.status = 'error'
      this.errorMessage = err instanceof Error ? err.message : String(err)
      this.renderAll()
    }
  }

  close(): void {
    if (this.hidden) return
    this.hidden = true
    this.sessionId = null
    this.events = []
    this.groups = []
    this.selectedCallId = null
    this.bodyHost.innerHTML = ''
    this.dispatchEvent(new CustomEvent('close', { bubbles: true }))
  }

  isOpen(): boolean {
    return !this.hidden
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !this.hidden) {
      e.preventDefault()
      e.stopPropagation()
      if (this.view === 'detail') this.toList()
      else this.close()
    }
  }

  private renderAll(): void {
    if (this.status === 'loading') {
      this.bodyHost.innerHTML = `<div class="tr-loading">Loading traces…</div>`
      return
    }
    if (this.status === 'error') {
      this.bodyHost.innerHTML = `<div class="tr-empty"><div class="tr-empty-title">Failed to load traces</div><div class="tr-empty-sub">${escapeHtml(this.errorMessage)}</div></div>`
      return
    }
    if (this.view === 'list') this.renderList()
    else this.renderDetail()
  }

  private renderList(): void {
    const calls = this.events.filter(e => e.t === 'call').length
    const execs = this.groups.length
    const totalMs = this.totalEnd > this.totalStart ? this.totalEnd - this.totalStart : 0
    const errors = this.totalErrors

    const titleTooltip = this.sessionLabel ? ` title="${escapeHtml(this.sessionLabel)}"` : ''
    const headHtml = `
      <div class="tr-head">
        <span class="tr-title"${titleTooltip}>Function trace</span>
        <span class="tr-stats">
          <span><span class="n">${execs}</span> ${execs === 1 ? 'exec' : 'execs'}</span>
          <span class="sep">·</span>
          <span><span class="n">${calls}</span> ${calls === 1 ? 'call' : 'calls'}</span>
          <span class="sep">·</span>
          <span class="n">${formatDuration(totalMs)}</span>
        </span>
        <button class="tr-icon-btn" data-close type="button" title="Close" aria-label="Close trace panel">${CLOSE_ICON_SVG}</button>
      </div>
    `

    let filtersHtml = ''
    if (errors > 0) {
      const allActive = this.filter === 'all' ? 'active' : ''
      const errActive = this.filter === 'errors' ? 'active' : ''
      filtersHtml = `
        <div class="tr-filters">
          <span class="tr-chip ${allActive}" data-filter="all">All <span class="tr-chip-count">${calls}</span></span>
          <span class="tr-chip err ${errActive}" data-filter="errors">Errors <span class="tr-chip-count">${errors}</span></span>
        </div>
      `
    }

    let bodyInner = ''
    if (this.groups.length === 0) {
      bodyInner = `<div class="tr-empty"><div class="tr-empty-title">No traces recorded</div><div class="tr-empty-sub">Function calls from execJs will appear here once the session runs code.</div></div>`
    } else {
      const visible = this.filter === 'errors' ? this.groups.filter(g => g.hasError) : this.groups
      if (visible.length === 0) {
        bodyInner = `<div class="tr-empty"><div class="tr-empty-title">No matches</div><div class="tr-empty-sub">No traces match the current filter.</div></div>`
      } else {
        bodyInner = `<div class="tr-list">${visible.map(g => this.renderExecCard(g)).join('')}</div>`
      }
    }

    this.bodyHost.innerHTML = headHtml + filtersHtml + `<div class="tr-body" data-list-body>${bodyInner}</div>`
    const body = this.bodyHost.querySelector<HTMLElement>('[data-list-body]')
    if (body) body.scrollTop = this.listScrollTop
  }

  private renderExecCard(g: ExecGroup): string {
    const expanded = this.expandedExecIds.has(g.execId)
    const exec = g.exec
    const ok = !g.hasError
    const desc = execHeaderText(exec)
    const span = Math.max(1, g.endedAt - g.startedAt)
    const totalMs = exec ? exec.durationMs : (g.endedAt - g.startedAt)

    const wfBars = g.calls.map(c => {
      const left = ((c.startedAt - g.startedAt) / span) * 100
      const w = Math.max(2, (c.durationMs / span) * 100)
      const cls = c.ok ? '' : 'err'
      return `<i class="${cls}" style="left:${clampPct(left)}%;width:${clampPct(w)}%"></i>`
    }).join('')

    const visibleCalls = this.filter === 'errors' ? g.calls.filter(c => !c.ok) : g.calls
    const callRows = expanded && visibleCalls.length > 0
      ? `<div class="tr-calls">${visibleCalls.map(c => this.renderCallRow(c, g)).join('')}</div>`
      : ''

    const dur = formatDuration(totalMs)
    const offset = this.totalStart > 0 ? formatTime(g.startedAt, this.totalStart) : ''
    const callCount = g.calls.length
    const countLabel = callCount === 1 ? '1 call' : callCount + ' calls'

    const metaParts = [`<span>${countLabel}</span>`]
    if (offset && offset !== '+0ms') {
      metaParts.push(`<span class="sep">·</span><span>${offset}</span>`)
    }

    const errorIndicator = ok ? '' : `<span class="tr-dot err" title="exec contains errors"></span>`
    const errClass = ok ? '' : 'errored'

    return `<div class="tr-exec ${expanded ? 'expanded' : 'collapsed'} ${errClass}" data-exec-id="${escapeHtml(g.execId)}">
      <div class="tr-exec-head" data-exec-toggle="${escapeHtml(g.execId)}">
        <div class="tr-exec-row">
          <span class="tr-caret">▼</span>
          ${errorIndicator}
          <span class="tr-exec-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>
          <span class="tr-exec-dur">${dur}</span>
        </div>
        <div class="tr-wf">${wfBars}</div>
        <div class="tr-exec-meta">${metaParts.join('')}</div>
      </div>
      ${callRows}
    </div>`
  }

  private renderCallRow(c: TraceCallEvent, g: ExecGroup): string {
    const span = Math.max(1, g.endedAt - g.startedAt)
    const left = ((c.startedAt - g.startedAt) / span) * 100
    const w = Math.max(2, (c.durationMs / span) * 100)
    const errCls = c.ok ? '' : 'err'
    const method = shortenMethod(c.method)
    const dur = formatDuration(c.durationMs)
    return `<div class="tr-call ${c.ok ? '' : 'errored'}" data-call-drill="${escapeHtml(c.id)}">
      <span class="tr-call-method" title="${escapeHtml(c.method)}">${escapeHtml(method)}</span>
      <div class="tr-mini"><i class="${errCls}" style="left:${clampPct(left)}%;width:${clampPct(w)}%"></i></div>
      <span class="tr-call-dur">${dur}</span>
      <span class="tr-chev">›</span>
    </div>`
  }

  private renderDetail(): void {
    const call = this.findCall(this.selectedCallId)
    if (!call) {
      this.toList()
      return
    }
    const group = this.groups.find(g => g.execId === call.execId) ?? null
    const exec = group?.exec ?? null
    const offset = this.totalStart > 0 ? formatTime(call.startedAt, this.totalStart) : ''
    const execIdx = group?.index ?? 0
    const callsLabel = group ? (group.calls.length === 1 ? '1 call' : group.calls.length + ' calls') : ''
    const desc = exec ? execHeaderText(exec) : ''

    const headHtml = `
      <div class="tr-det-head">
        <button class="tr-back" data-back type="button">${BACK_ICON_SVG}<span>Back</span></button>
        <span class="tr-det-method" title="${escapeHtml(call.method)}">${escapeHtml(call.method)}</span>
        <button class="tr-icon-btn" data-close type="button" style="margin-left:auto;" title="Close" aria-label="Close trace panel">${CLOSE_ICON_SVG}</button>
      </div>
    `

    const items: string[] = []
    items.push(`<span class="tr-meta-item ${call.ok ? 'ok' : 'err'}"><span class="tr-dot"></span>${call.ok ? 'ok' : 'error'}</span>`)
    items.push(`<span class="tr-meta-item">${formatDuration(call.durationMs)}</span>`)
    if (offset) items.push(`<span class="tr-meta-item">${offset}</span>`)
    if (execIdx > 0 && callsLabel) items.push(`<span class="tr-meta-item">exec #${execIdx} · ${escapeHtml(callsLabel)}</span>`)
    const badges = items.join('<span class="tr-meta-sep">·</span>')

    const errorCard = call.ok || !call.error ? '' : `
      <div class="tr-error-card">
        <div class="name">${escapeHtml(call.error.name)}</div>
        <div class="msg">${escapeHtml(call.error.message)}</div>
      </div>
    `

    const sections: string[] = []
    sections.push(this.section('Params', call.paramsTruncated, `<pre>${escapeHtml(formatJsonMaybe(call.paramsPreview))}</pre>`, 'params'))
    if (call.ok && call.resultPreview !== null) {
      sections.push(this.section('Result', call.resultTruncated, `<pre>${escapeHtml(formatJsonMaybe(call.resultPreview))}</pre>`, 'result'))
    }
    if (exec) {
      sections.push(this.section('Called from execJs', exec.codeTruncated, `<pre>${escapeHtml(exec.code)}</pre>`, 'code'))
    }

    const titleHtml = desc ? `<div class="tr-det-title">${escapeHtml(desc)}</div>` : ''

    const body = `
      <div class="tr-det-body">
        ${titleHtml}
        <div class="tr-badges">${badges}</div>
        ${errorCard}
        ${sections.join('')}
      </div>
    `

    this.bodyHost.innerHTML = headHtml + body
    const detBody = this.bodyHost.querySelector<HTMLElement>('.tr-det-body')
    if (detBody) detBody.scrollTop = 0
  }

  private section(label: string, truncated: boolean, body: string, copyKey: string): string {
    const truncPill = truncated ? `<span class="tr-trunc-pill">truncated</span>` : ''
    return `<div class="tr-section">
      <h5>${escapeHtml(label)}<span class="side">${truncPill}<button class="tr-copy" data-copy="${escapeHtml(copyKey)}" type="button">Copy</button></span></h5>
      ${body}
    </div>`
  }

  private toDetail(callId: string): void {
    const body = this.bodyHost.querySelector<HTMLElement>('[data-list-body]')
    if (body) this.listScrollTop = body.scrollTop
    this.selectedCallId = callId
    this.view = 'detail'
    this.renderAll()
  }

  private toList(): void {
    this.view = 'list'
    this.selectedCallId = null
    this.renderAll()
  }

  private findCall(callId: string | null): TraceCallEvent | null {
    if (!callId) return null
    for (const ev of this.events) {
      if (ev.t === 'call' && ev.id === callId) return ev
    }
    return null
  }

  private onCardClick = (e: Event) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-close]')) { e.preventDefault(); this.close(); return }
    if (target.closest('[data-back]')) { e.preventDefault(); this.toList(); return }

    const chip = target.closest('[data-filter]') as HTMLElement | null
    if (chip) {
      const f = chip.dataset.filter
      if (f === 'all' || f === 'errors') {
        this.filter = f
        this.listScrollTop = 0
        this.renderList()
      }
      return
    }

    const copyBtn = target.closest('[data-copy]') as HTMLButtonElement | null
    if (copyBtn) { e.stopPropagation(); void this.handleCopy(copyBtn); return }

    const callRow = target.closest('[data-call-drill]') as HTMLElement | null
    if (callRow?.dataset.callDrill) {
      e.preventDefault()
      this.toDetail(callRow.dataset.callDrill)
      return
    }

    const execHead = target.closest('[data-exec-toggle]') as HTMLElement | null
    if (execHead?.dataset.execToggle) this.toggleExec(execHead.dataset.execToggle)
  }

  /** Toggle a single exec without re-rendering the whole list. */
  private toggleExec(id: string): void {
    const card = this.bodyHost.querySelector<HTMLElement>(`.tr-exec[data-exec-id="${CSS.escape(id)}"]`)
    if (!card) return
    if (this.expandedExecIds.has(id)) {
      this.expandedExecIds.delete(id)
      card.classList.remove('expanded')
      card.classList.add('collapsed')
      const calls = card.querySelector('.tr-calls')
      if (calls) calls.remove()
    } else {
      this.expandedExecIds.add(id)
      card.classList.remove('collapsed')
      card.classList.add('expanded')
      const group = this.groups.find(g => g.execId === id)
      if (!group) return
      const visible = this.filter === 'errors' ? group.calls.filter(c => !c.ok) : group.calls
      if (visible.length === 0) return
      const html = `<div class="tr-calls">${visible.map(c => this.renderCallRow(c, group)).join('')}</div>`
      card.insertAdjacentHTML('beforeend', html)
    }
  }

  private async handleCopy(btn: HTMLButtonElement): Promise<void> {
    const key = btn.dataset.copy
    if (!key) return
    const call = this.findCall(this.selectedCallId)
    if (!call) return
    const exec = this.groups.find(g => g.execId === call.execId)?.exec
    let text = ''
    if (key === 'params') text = call.paramsPreview
    else if (key === 'result') text = call.resultPreview ?? ''
    else if (key === 'code') text = exec?.code ?? ''
    await copyToButton(btn, text)
  }
}
