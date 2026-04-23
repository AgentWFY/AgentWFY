import { escapeHtml } from './chat_utils.js'
import type { TraceEvent, TraceExecEvent, TraceCallEvent } from '../ipc-types/index.js'

interface ExecGroup {
  exec: TraceExecEvent | null
  execId: string
  calls: TraceCallEvent[]
  startedAt: number
  totalDurationMs: number
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

function groupEvents(events: TraceEvent[]): { groups: ExecGroup[]; totalStart: number; totalEnd: number; maxCallDurationMs: number } {
  const byExecId = new Map<string, ExecGroup>()
  const execOnly: TraceExecEvent[] = []

  for (const ev of events) {
    if (ev.t === 'exec') {
      execOnly.push(ev)
      const prev = byExecId.get(ev.id)
      if (prev) {
        prev.exec = ev
        prev.startedAt = Math.min(prev.startedAt, ev.startedAt)
      } else {
        byExecId.set(ev.id, {
          exec: ev,
          execId: ev.id,
          calls: [],
          startedAt: ev.startedAt,
          totalDurationMs: ev.durationMs,
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
          calls: [],
          startedAt: ev.startedAt,
          totalDurationMs: 0,
        }
        byExecId.set(ev.execId, group)
      }
      group.calls.push(ev)
      if (group.startedAt === 0 || ev.startedAt < group.startedAt) {
        group.startedAt = ev.startedAt
      }
    }
  }

  const groups = Array.from(byExecId.values())
  for (const g of groups) {
    g.calls.sort((a, b) => a.startedAt - b.startedAt)
  }
  groups.sort((a, b) => a.startedAt - b.startedAt)

  let totalStart = Infinity
  let totalEnd = 0
  let maxCallDurationMs = 1
  for (const g of groups) {
    totalStart = Math.min(totalStart, g.startedAt)
    const execEnd = g.startedAt + g.totalDurationMs
    totalEnd = Math.max(totalEnd, execEnd)
    for (const c of g.calls) {
      totalEnd = Math.max(totalEnd, c.startedAt + c.durationMs)
      if (c.durationMs > maxCallDurationMs) maxCallDurationMs = c.durationMs
    }
  }

  if (!isFinite(totalStart)) totalStart = 0

  return { groups, totalStart, totalEnd, maxCallDurationMs }
}

const STYLES = `
  awfy-trace-panel {
    display: flex;
    flex-direction: column;
    position: absolute;
    inset: 0;
    z-index: 50;
    background: var(--color-modal-overlay);
    backdrop-filter: blur(6px) saturate(120%);
    -webkit-backdrop-filter: blur(6px) saturate(120%);
    padding: 14px;
    box-sizing: border-box;
    animation: tr-fade 160ms ease-out;
  }
  awfy-trace-panel[hidden] { display: none; }
  @keyframes tr-fade { from { opacity: 0; } to { opacity: 1; } }
  .tr-card {
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: var(--color-bg1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--color-modal-shadow);
    animation: tr-rise 200ms cubic-bezier(0.2, 0.8, 0.25, 1);
  }
  @keyframes tr-rise {
    from { transform: translateY(8px) scale(0.985); opacity: 0; }
    to   { transform: translateY(0) scale(1); opacity: 1; }
  }
  .tr-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 10px 10px 16px;
    flex-shrink: 0;
  }
  .tr-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--color-text4);
    font-weight: 600;
    letter-spacing: -0.1px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    overflow: hidden;
  }
  .tr-title-label { flex-shrink: 0; }
  .tr-title-meta {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text2);
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .tr-close {
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--color-text2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    border-radius: 7px;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tr-close:hover {
    background: var(--color-item-hover);
    color: var(--color-text4);
  }
  .tr-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 2px 6px 12px;
    scrollbar-gutter: stable;
  }
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
  .tr-group {
    margin: 6px 0 10px;
    border-radius: var(--radius-sm);
  }
  .tr-exec {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 4px;
    cursor: pointer;
    user-select: none;
    border-radius: 5px;
    transition: background var(--transition-fast);
  }
  .tr-exec:hover { background: var(--color-item-hover); }
  .tr-caret {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: var(--color-text2);
    transition: transform 120ms ease;
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
  .tr-exec-count {
    flex-shrink: 0;
    font-size: 10.5px;
    color: var(--color-text2);
    font-family: var(--font-mono, ui-monospace, monospace);
    letter-spacing: 0.2px;
  }
  .tr-exec-dur {
    flex-shrink: 0;
    font-size: 10.5px;
    color: var(--color-text2);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
    min-width: 52px;
    text-align: right;
  }
  .tr-exec.errored .tr-status { background: var(--color-red-fg); }
  .tr-call-row.errored .tr-status { background: var(--color-red-fg); }
  .tr-status {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-green-fg);
    flex-shrink: 0;
  }
  .tr-calls { display: flex; flex-direction: column; }
  .tr-group.collapsed .tr-calls { display: none; }
  .tr-call-row {
    display: grid;
    grid-template-columns: 16px minmax(100px, 1fr) minmax(60px, 1.6fr) 52px;
    align-items: center;
    gap: 8px;
    padding: 3px 8px 3px 14px;
    cursor: pointer;
    border-radius: 4px;
    user-select: none;
    transition: background var(--transition-fast);
  }
  .tr-call-row:hover { background: var(--color-item-hover); }
  .tr-call-row.selected { background: var(--color-item-hover); }
  .tr-call-method {
    font-size: 12px;
    color: var(--color-text4);
    font-family: var(--font-mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr-call-row.errored .tr-call-method { color: var(--color-red-fg); }
  .tr-bar-wrap {
    position: relative;
    height: 8px;
    background: var(--color-bg2);
    border-radius: 2px;
    overflow: hidden;
  }
  .tr-bar {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    background: var(--color-accent);
    border-radius: 2px;
    min-width: 2px;
  }
  .tr-call-row.errored .tr-bar { background: var(--color-red-fg); }
  .tr-call-dur {
    font-size: 10.5px;
    color: var(--color-text2);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .tr-detail {
    margin: 4px 0 12px 24px;
    padding: 10px 12px;
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tr-detail[hidden] { display: none; }
  .tr-detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--color-text3);
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .tr-detail-method {
    font-weight: 600;
    color: var(--color-text4);
  }
  .tr-detail-meta {
    color: var(--color-text2);
    font-size: 10.5px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tr-detail-sep {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--color-text2);
    opacity: 0.5;
  }
  .tr-section-label {
    font-size: 9.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--color-text2);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tr-trunc-pill {
    font-size: 9px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0.2px;
    color: var(--color-text2);
    background: var(--color-bg3);
    padding: 1px 6px;
    border-radius: 999px;
  }
  .tr-section-block {
    margin: 4px 0 0;
    padding: 8px 10px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--color-text4);
    background: var(--color-code-bg);
    border-radius: 5px;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tr-section-block.tr-error-block {
    background: var(--color-red-bg);
    color: var(--color-red-fg);
  }
  .tr-error-name { font-weight: 700; margin-bottom: 2px; }
`

type TraceLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'

export class TlTracePanel extends HTMLElement {
  private styleEl!: HTMLStyleElement
  private cardEl!: HTMLElement
  private headMetaEl!: HTMLElement
  private bodyEl!: HTMLElement

  private sessionId: string | null = null
  private sessionLabel = ''
  private events: TraceEvent[] = []
  private groups: ExecGroup[] = []
  private totalStart = 0
  private totalEnd = 0
  private maxCallDurationMs = 1
  private status: TraceLoadStatus = 'idle'
  private errorMessage = ''
  private expandedExecIds = new Set<string>()
  private selectedCallId: string | null = null

  connectedCallback() {
    this.hidden = true
    this.styleEl = document.createElement('style')
    this.styleEl.textContent = STYLES
    this.appendChild(this.styleEl)

    this.cardEl = document.createElement('div')
    this.cardEl.className = 'tr-card'

    const head = document.createElement('div')
    head.className = 'tr-head'

    const title = document.createElement('div')
    title.className = 'tr-title'
    const label = document.createElement('span')
    label.className = 'tr-title-label'
    label.textContent = 'Function trace'
    this.headMetaEl = document.createElement('span')
    this.headMetaEl.className = 'tr-title-meta'
    title.append(label, this.headMetaEl)

    const close = document.createElement('button')
    close.className = 'tr-close'
    close.type = 'button'
    close.title = 'Close'
    close.setAttribute('aria-label', 'Close trace panel')
    close.textContent = '×'
    close.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.close()
    })

    head.append(title, close)

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'tr-body'
    this.bodyEl.addEventListener('click', this.onBodyClick)

    this.cardEl.append(head, this.bodyEl)
    this.appendChild(this.cardEl)

    this.addEventListener('mousedown', (e) => {
      if (e.target === this) {
        e.preventDefault()
        this.close()
      }
    })

    document.addEventListener('keydown', this.onKeydown, true)
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.onKeydown, true)
  }

  async open(sessionId: string, sessionLabel: string): Promise<void> {
    this.sessionId = sessionId
    this.sessionLabel = sessionLabel
    this.hidden = false
    this.status = 'loading'
    this.events = []
    this.groups = []
    this.selectedCallId = null
    this.render()

    const ipc = window.ipc
    if (!ipc?.traces) {
      this.status = 'error'
      this.errorMessage = 'Trace API not available'
      this.render()
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
      this.maxCallDurationMs = Math.max(1, grouped.maxCallDurationMs)
      this.expandedExecIds = new Set(this.groups.map(g => g.execId))
      this.status = 'loaded'
      this.render()
    } catch (err) {
      this.status = 'error'
      this.errorMessage = err instanceof Error ? err.message : String(err)
      this.render()
    }
  }

  close(): void {
    this.hidden = true
    this.sessionId = null
    this.events = []
    this.groups = []
    this.selectedCallId = null
    this.bodyEl.innerHTML = ''
  }

  isOpen(): boolean {
    return !this.hidden
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !this.hidden) {
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
  }

  private render(): void {
    this.renderHeadMeta()
    this.renderBody()
  }

  private renderHeadMeta(): void {
    if (!this.headMetaEl) return
    if (this.status === 'loading') {
      this.headMetaEl.textContent = this.sessionLabel ? '· ' + this.sessionLabel : ''
      return
    }
    if (this.status === 'error') {
      this.headMetaEl.textContent = '· error'
      return
    }

    const calls = this.events.filter(e => e.t === 'call').length
    const execs = this.groups.length
    const totalMs = this.totalEnd > this.totalStart ? this.totalEnd - this.totalStart : 0
    const parts: string[] = []
    if (execs > 0) parts.push(execs === 1 ? '1 exec' : execs + ' execs')
    if (calls > 0) parts.push(calls === 1 ? '1 call' : calls + ' calls')
    if (totalMs > 0) parts.push(formatDuration(totalMs))
    if (this.sessionLabel) parts.push(this.sessionLabel)

    this.headMetaEl.textContent = parts.length > 0 ? '· ' + parts.join(' · ') : ''
  }

  private renderBody(): void {
    if (this.status === 'loading') {
      this.bodyEl.innerHTML = '<div class="tr-loading">Loading traces…</div>'
      return
    }
    if (this.status === 'error') {
      this.bodyEl.innerHTML = `<div class="tr-empty"><div class="tr-empty-title">Failed to load traces</div><div class="tr-empty-sub">${escapeHtml(this.errorMessage)}</div></div>`
      return
    }
    if (this.groups.length === 0) {
      this.bodyEl.innerHTML = '<div class="tr-empty"><div class="tr-empty-title">No traces recorded</div><div class="tr-empty-sub">Function calls from execJs will appear here once the session runs code.</div></div>'
      return
    }

    const parts: string[] = []
    for (const group of this.groups) {
      parts.push(this.renderGroup(group))
    }
    this.bodyEl.innerHTML = parts.join('')
  }

  private renderGroup(group: ExecGroup): string {
    const expanded = this.expandedExecIds.has(group.execId)
    const exec = group.exec
    const ok = exec ? exec.ok : group.calls.every(c => c.ok)
    const headerText = execHeaderText(exec)
    const totalMs = exec ? exec.durationMs : group.calls.reduce((m, c) => Math.max(m, c.startedAt + c.durationMs - group.startedAt), 0)

    const caret = `<svg class="tr-caret" viewBox="0 0 12 12" fill="currentColor"><path d="M3 4l3 4 3-4z"/></svg>`
    const execClasses = ['tr-exec']
    if (!expanded) execClasses.push('collapsed')
    if (!ok) execClasses.push('errored')

    let callsHtml = ''
    if (expanded && group.calls.length > 0) {
      const callRows = group.calls.map(c => this.renderCallRow(c, exec)).join('')
      callsHtml = `<div class="tr-calls">${callRows}</div>`
    }

    const groupClasses = ['tr-group']
    if (!expanded) groupClasses.push('collapsed')

    const execCount = group.calls.length
    const countLabel = execCount === 1 ? '1 call' : execCount + ' calls'

    return `<div class="${groupClasses.join(' ')}" data-exec-id="${escapeHtml(group.execId)}">
      <div class="${execClasses.join(' ')}" data-exec-toggle="${escapeHtml(group.execId)}">
        ${caret}
        <span class="tr-status"></span>
        <span class="tr-exec-desc" title="${escapeHtml(headerText)}">${escapeHtml(headerText)}</span>
        <span class="tr-exec-count">${countLabel}</span>
        <span class="tr-exec-dur">${formatDuration(totalMs)}</span>
      </div>
      ${callsHtml}
    </div>`
  }

  private renderCallRow(call: TraceCallEvent, exec: TraceExecEvent | null): string {
    const selected = this.selectedCallId === call.id
    const classes = ['tr-call-row']
    if (!call.ok) classes.push('errored')
    if (selected) classes.push('selected')

    const barPct = Math.max(2, Math.min(100, (call.durationMs / this.maxCallDurationMs) * 100))
    const method = shortenMethod(call.method)
    const dur = formatDuration(call.durationMs)

    const mainRow = `<div class="${classes.join(' ')}" data-call-id="${escapeHtml(call.id)}">
      <span class="tr-status"></span>
      <span class="tr-call-method" title="${escapeHtml(call.method)}">${escapeHtml(method)}</span>
      <div class="tr-bar-wrap"><div class="tr-bar" style="width:${barPct.toFixed(2)}%"></div></div>
      <span class="tr-call-dur">${dur}</span>
    </div>`

    if (!selected) return mainRow

    return mainRow + this.renderCallDetail(call, exec)
  }

  private renderCallDetail(call: TraceCallEvent, exec: TraceExecEvent | null): string {
    const baseTs = exec?.startedAt ?? call.startedAt
    const metaParts: string[] = [
      call.ok ? 'ok' : 'error',
      formatDuration(call.durationMs),
      formatTime(call.startedAt, baseTs),
    ]
    const meta = metaParts.map((p, i) => {
      if (i === 0) return `<span>${escapeHtml(p)}</span>`
      return `<span class="tr-detail-sep"></span><span>${escapeHtml(p)}</span>`
    }).join('')

    const sections: string[] = []
    sections.push(`<div class="tr-detail-head">
      <span class="tr-detail-method">${escapeHtml(call.method)}</span>
      <span class="tr-detail-meta">${meta}</span>
    </div>`)

    const paramsLabel = this.sectionLabel('Params', call.paramsTruncated)
    sections.push(`${paramsLabel}<pre class="tr-section-block">${escapeHtml(formatJsonMaybe(call.paramsPreview))}</pre>`)

    if (call.ok) {
      if (call.resultPreview !== null) {
        const label = this.sectionLabel('Result', call.resultTruncated)
        sections.push(`${label}<pre class="tr-section-block">${escapeHtml(formatJsonMaybe(call.resultPreview))}</pre>`)
      }
    } else if (call.error) {
      sections.push(`<div class="tr-section-label">Error</div><div class="tr-section-block tr-error-block"><div class="tr-error-name">${escapeHtml(call.error.name)}</div>${escapeHtml(call.error.message)}</div>`)
    }

    if (exec) {
      const codeLabel = this.sectionLabel('Called from execJs', exec.codeTruncated)
      sections.push(`${codeLabel}<pre class="tr-section-block">${escapeHtml(exec.code)}</pre>`)
    }

    return `<div class="tr-detail">${sections.join('')}</div>`
  }

  private sectionLabel(text: string, truncated: boolean): string {
    const pill = truncated ? '<span class="tr-trunc-pill">truncated</span>' : ''
    return `<div class="tr-section-label"><span>${escapeHtml(text)}</span>${pill}</div>`
  }

  private onBodyClick = (e: Event) => {
    const target = e.target as HTMLElement
    const callRow = target.closest('.tr-call-row[data-call-id]') as HTMLElement | null
    if (callRow) {
      const id = callRow.dataset.callId
      if (!id) return
      this.selectedCallId = this.selectedCallId === id ? null : id
      this.renderBody()
      return
    }

    const execToggle = target.closest('[data-exec-toggle]') as HTMLElement | null
    if (execToggle) {
      const id = execToggle.dataset.execToggle
      if (!id) return
      if (this.expandedExecIds.has(id)) this.expandedExecIds.delete(id)
      else this.expandedExecIds.add(id)
      this.renderBody()
    }
  }
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
