import { renderMarkdown } from '../markdown.js'
import type { DisplayMessage, Block } from '../../agent/provider_types.js'
import { escapeHtml, imageDataUrl } from './chat_utils.js'

export interface ToolPair {
  id: string
  description: string
  code: string
  result: unknown
  isError: boolean
}

interface RenderFile {
  mimeType: string
  data: string
}

interface RenderBlock {
  type: 'user' | 'assistant'
  text: string
  thinking: string
  error: string
  tools: ToolPair[]
  files: RenderFile[]
  ref: DisplayMessage
}

export function buildRenderBlocks(msgs: DisplayMessage[]): RenderBlock[] {
  const blocks: RenderBlock[] = []

  for (const msg of msgs) {
    if (msg.role === 'user') {
      const text = msg.blocks
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('')
      const files: RenderFile[] = msg.blocks
        .filter(b => b.type === 'file')
        .map(b => {
          const f = b as { type: 'file'; mimeType: string; data: string }
          return { mimeType: f.mimeType, data: f.data }
        })
      blocks.push({ type: 'user', text, thinking: '', error: '', tools: [], files, ref: msg })
    } else if (msg.role === 'assistant') {
      // Split into segments at tool call boundaries to preserve interleaved order.
      // Each segment before a tool group gets its own render block, so text after
      // tool calls renders below them rather than being merged above.
      const segments: Array<{ textParts: string[]; thinkingParts: string[]; tools: ToolPair[]; errorText: string }> = []
      let current = { textParts: [] as string[], thinkingParts: [] as string[], tools: [] as ToolPair[], errorText: '' }

      for (const block of msg.blocks) {
        if (block.type === 'text') {
          // If we had tools in the current segment, start a new segment for text after tools
          if (current.tools.length > 0) {
            segments.push(current)
            current = { textParts: [], thinkingParts: [], tools: [], errorText: '' }
          }
          current.textParts.push(block.text)
        } else if (block.type === 'thinking') {
          if (current.tools.length > 0) {
            segments.push(current)
            current = { textParts: [], thinkingParts: [], tools: [], errorText: '' }
          }
          current.thinkingParts.push(block.text)
        } else if (block.type === 'error') {
          current.errorText = block.text
        } else if (block.type === 'exec_js') {
          const resultBlock = msg.blocks.find(
            b => b.type === 'exec_js_result' && (b as Block & { type: 'exec_js_result' }).id === block.id
          )
          current.tools.push({
            id: block.id,
            description: block.description || 'Executing code',
            code: block.code,
            result: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.content : null,
            isError: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.isError : false,
          })
        }
      }
      segments.push(current)

      // Emit one render block per segment, sharing the same message ref
      for (const seg of segments) {
        if (!seg.textParts.join('').trim() && !seg.thinkingParts.join('').trim() && !seg.errorText && seg.tools.length === 0) continue
        blocks.push({
          type: 'assistant',
          text: seg.textParts.join(''),
          thinking: seg.thinkingParts.join(''),
          error: seg.errorText,
          tools: seg.tools,
          files: [],
          ref: msg,
        })
      }
    }
  }

  return blocks
}

function extractFilesFromResult(result: unknown): { files: Array<{ data: string; mimeType: string }>; filteredResult: unknown } {
  const files: Array<{ data: string; mimeType: string }> = []
  if (!Array.isArray(result)) return { files, filteredResult: result }

  const filtered = result.filter((item: Record<string, unknown>) => {
    if (item?.type === 'file' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      files.push({ data: item.data, mimeType: item.mimeType })
      return false
    }
    return true
  })

  return { files, filteredResult: filtered }
}

export interface ParsedResult {
  value?: string
  error?: { name: string; message: string }
  logs: Array<{ level: string; message: string }>
  files: Array<{ data: string; mimeType: string }>
}

export function parseToolResult(result: unknown): ParsedResult {
  const { files, filteredResult } = extractFilesFromResult(result)

  // Extract text from content array
  let text = ''
  if (Array.isArray(filteredResult)) {
    const textParts = filteredResult
      .filter((item: Record<string, unknown>) => item?.type === 'text')
      .map((item: Record<string, unknown>) => item.text as string)
    text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(filteredResult, null, 2)
  } else {
    text = typeof filteredResult === 'string' ? filteredResult : JSON.stringify(filteredResult, null, 2)
  }

  // Try to parse as ExecJsDetails JSON
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && ('ok' in parsed || 'value' in parsed || 'error' in parsed)) {
      const logs: ParsedResult['logs'] = []
      if (Array.isArray(parsed.logs)) {
        for (const entry of parsed.logs) {
          if (entry && typeof entry.message === 'string') {
            logs.push({ level: entry.level || 'log', message: entry.message })
          }
        }
      }
      const out: ParsedResult = { logs, files }
      if (parsed.error && typeof parsed.error === 'object') {
        out.error = { name: parsed.error.name || 'Error', message: parsed.error.message || String(parsed.error) }
      } else if ('value' in parsed) {
        const val = parsed.value
        out.value = typeof val === 'string' ? val : JSON.stringify(val, null, 2)
      }
      return out
    }
  } catch { /* not JSON or not ExecJsDetails — fall through */ }

  // Fallback: treat entire text as the value
  return { value: text, logs: [], files }
}

const LOG_LEVELS: Record<string, { cls: string; label: string }> = {
  warn: { cls: 'l-warn', label: 'warn' },
  error: { cls: 'l-error', label: 'error' },
  info: { cls: 'l-info', label: 'info' },
}
const LOG_DEFAULT = { cls: 'l-log', label: 'log' }

function renderLogEntry(log: { level: string; message: string }): string {
  const { cls, label } = LOG_LEVELS[log.level] || LOG_DEFAULT
  return `<div class="log-entry"><span class="log-level ${cls}">${label}</span><span class="log-msg">${escapeHtml(log.message)}</span></div>`
}

function renderToolHtml(tool: ToolPair): string {
  return `<div class="tool-header" data-tool-id="${escapeHtml(tool.id)}">
    <span class="tool-description">${escapeHtml(tool.description)}</span>
    ${tool.isError ? '<span class="tool-error-badge">error</span>' : ''}
  </div>`
}

export function findToolPair(messages: DisplayMessage[], toolId: string): ToolPair | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type === 'exec_js' && block.id === toolId) {
        const resultBlock = msg.blocks.find(
          b => b.type === 'exec_js_result' && (b as Block & { type: 'exec_js_result' }).id === block.id
        )
        return {
          id: block.id,
          description: block.description || 'Executing code',
          code: block.code,
          result: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.content : null,
          isError: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.isError : false,
        }
      }
    }
  }
  return null
}

function tpSection(opts: {
  label: string
  meta?: string
  truncated?: boolean
  copyKey?: string
  body: string
}): string {
  const sideParts: string[] = []
  if (opts.meta) sideParts.push(`<span class="tp-section-meta">${escapeHtml(opts.meta)}</span>`)
  if (opts.truncated) sideParts.push(`<span class="tp-trunc-pill">truncated</span>`)
  if (opts.copyKey) sideParts.push(`<button class="tp-copy" data-copy="${escapeHtml(opts.copyKey)}" type="button">Copy</button>`)
  const side = sideParts.length > 0 ? `<span class="tp-section-side">${sideParts.join('')}</span>` : ''
  return `<section class="tp-section"><div class="tp-section-label">${escapeHtml(opts.label)}${side}</div>${opts.body}</section>`
}

export function renderToolStatusPillHtml(tool: ToolPair, parsed?: ParsedResult): string {
  if (tool.result === null && !tool.isError) {
    return `<span class="tp-status running"><span class="tp-status-dot"></span>running</span>`
  }
  const p = parsed ?? parseToolResult(tool.result)
  const hasError = tool.isError || !!p.error
  if (hasError) {
    return `<span class="tp-status err"><span class="tp-status-dot"></span>error</span>`
  }
  return `<span class="tp-status ok" title="ok"><span class="tp-status-dot"></span></span>`
}

export function resolveToolCopyText(tool: ToolPair, key: string): string {
  if (key === 'code') return tool.code
  const parsed = parseToolResult(tool.result)
  if (key === 'value') return parsed.value ?? ''
  if (key === 'error') {
    if (!parsed.error) return ''
    return parsed.error.name + ': ' + parsed.error.message
  }
  if (key === 'logs') {
    return parsed.logs.map(l => `[${l.level}] ${l.message}`).join('\n')
  }
  return ''
}

export function renderToolDetailsHtml(tool: ToolPair, parsed?: ParsedResult): string {
  const p = parsed ?? parseToolResult(tool.result)
  const hasError = tool.isError || !!p.error
  const imageFiles = p.files.filter(f => f.mimeType.startsWith('image/'))
  const nonImageFiles = p.files.filter(f => !f.mimeType.startsWith('image/'))

  const parts: string[] = []

  if (hasError && p.error) {
    parts.push(`<div class="tp-error-card"><div class="tp-error-name">${escapeHtml(p.error.name)}</div><div class="tp-error-msg">${escapeHtml(p.error.message)}</div></div>`)
  }

  if (tool.code) {
    parts.push(tpSection({
      label: 'Code',
      copyKey: 'code',
      body: `<pre class="tp-block tp-code">${escapeHtml(tool.code)}</pre>`,
    }))
  }

  if (!hasError) {
    if (p.value !== undefined) {
      parts.push(tpSection({
        label: 'Return value',
        copyKey: 'value',
        body: `<pre class="tp-block tp-value">${escapeHtml(p.value)}</pre>`,
      }))
    } else if (tool.result === null) {
      parts.push(tpSection({
        label: 'Result',
        body: '<div class="tp-empty-inline">Still running…</div>',
      }))
    }
  }

  if (p.logs.length > 0) {
    const rows = p.logs.map(renderLogEntry).join('')
    const meta = `${p.logs.length} message${p.logs.length !== 1 ? 's' : ''}`
    parts.push(tpSection({
      label: 'Console',
      meta,
      copyKey: 'logs',
      body: `<div class="tp-logs">${rows}</div>`,
    }))
  }

  if (imageFiles.length > 0) {
    const items = imageFiles.map(f => {
      const ext = f.mimeType.split('/')[1]?.toUpperCase() || 'IMG'
      return `<figure class="tp-img-wrap"><img src="${imageDataUrl(f.mimeType, f.data)}"><figcaption class="tp-img-meta"><span class="tp-img-pill">${escapeHtml(ext)}</span></figcaption></figure>`
    }).join('')
    const label = imageFiles.length === 1 ? 'Image' : 'Images'
    parts.push(tpSection({
      label,
      meta: String(imageFiles.length),
      body: `<div class="tp-images">${items}</div>`,
    }))
  }

  if (nonImageFiles.length > 0) {
    const badges = nonImageFiles.map(f => `<span class="tp-file-badge">${escapeHtml(f.mimeType)}</span>`).join('')
    parts.push(tpSection({
      label: 'Files',
      meta: String(nonImageFiles.length),
      body: `<div class="tp-files">${badges}</div>`,
    }))
  }

  if (parts.length === 0) {
    return '<div class="tp-empty">No output</div>'
  }

  return parts.join('')
}

// --- Incremental DOM rendering ---

interface BlockCacheEntry {
  messageKey: number
  blockType: 'user' | 'assistant'
  textLen: number
  thinkingLen: number
  errorLen: number
  toolCount: number
  toolResultCount: number
  toolIds: string
  fileCount: number
}

const _blockCache = new WeakMap<HTMLElement, BlockCacheEntry>()
const _indicatorCache = new WeakMap<HTMLElement, string>()

function blockCacheEntry(block: RenderBlock): BlockCacheEntry {
  return {
    messageKey: block.ref.timestamp,
    blockType: block.type === 'user' ? 'user' : 'assistant',
    textLen: block.text.length,
    thinkingLen: block.thinking.length,
    errorLen: block.error.length,
    toolCount: block.tools.length,
    toolResultCount: block.tools.reduce((n, t) => n + (t.result !== null ? 1 : 0), 0),
    toolIds: block.tools.length > 0 ? block.tools.map(t => t.id).join('|') : '',
    fileCount: block.files.length,
  }
}

function blockCacheMatches(a: BlockCacheEntry, b: BlockCacheEntry): boolean {
  return a.messageKey === b.messageKey
    && a.blockType === b.blockType
    && a.textLen === b.textLen
    && a.thinkingLen === b.thinkingLen
    && a.errorLen === b.errorLen
    && a.toolCount === b.toolCount
    && a.toolResultCount === b.toolResultCount
    && a.toolIds === b.toolIds
    && a.fileCount === b.fileCount
}

function renderUserFilesHtml(files: RenderFile[]): string {
  if (files.length === 0) return ''
  const parts = files.map(f => {
    if (f.mimeType.startsWith('image/')) {
      return `<img class="user-file-image" src="${imageDataUrl(f.mimeType, f.data)}" alt="attachment">`
    }
    return `<span class="file-badge">${escapeHtml(f.mimeType)}</span>`
  })
  return `<div class="user-files">${parts.join('')}</div>`
}

function renderBlockHtml(block: RenderBlock): string {
  if (block.type === 'user') {
    const textHtml = block.text ? renderMarkdown(block.text) : ''
    return `<div class="block block-user">${textHtml}${renderUserFilesHtml(block.files)}</div>`
  }
  if (block.type === 'assistant') {
    if (!block.text.trim() && !block.thinking.trim() && !block.error && block.tools.length === 0) return ''
    let html = '<div class="block block-assistant">'
    if (block.thinking) {
      html += `<div class="thinking-text">${renderMarkdown(block.thinking)}</div>`
    }
    if (block.text) {
      html += `<div class="assistant-text">${renderMarkdown(block.text)}</div>`
    }
    if (block.tools.length > 0) {
      html += '<div class="tools-group">'
      for (const tool of block.tools) {
        html += renderToolHtml(tool)
      }
      html += '</div>'
    }
    if (block.error) {
      html += `<div class="error-banner">${renderMarkdown(block.error)}</div>`
    }
    html += '</div>'
    return html
  }
  return ''
}

function renderIndicatorHtml(isStreaming: boolean): string {
  if (!isStreaming) return ''
  return '<div class="thinking-dots"><span></span><span></span><span></span></div>'
}

export function updateMessagesEl(
  container: HTMLElement,
  blocks: RenderBlock[],
  isStreaming: boolean,
): void {
  let indicator = container.querySelector<HTMLElement>('#streaming-indicator')
  let anchor = container.querySelector<HTMLElement>('#anchor')
  if (!anchor) {
    anchor = document.createElement('div')
    anchor.id = 'anchor'
    container.appendChild(anchor)
  }
  if (!indicator) {
    indicator = document.createElement('div')
    indicator.id = 'streaming-indicator'
    container.insertBefore(indicator, anchor)
  }

  const wrappers = container.querySelectorAll<HTMLElement>(':scope > [data-msg-idx]')

  for (let i = blocks.length; i < wrappers.length; i++) {
    wrappers[i].remove()
  }

  const existingCount = Math.min(wrappers.length, blocks.length)
  for (let i = 0; i < existingCount; i++) {
    const entry = blockCacheEntry(blocks[i])
    const cached = _blockCache.get(wrappers[i])
    if (cached && blockCacheMatches(cached, entry)) continue
    wrappers[i].innerHTML = renderBlockHtml(blocks[i])
    _blockCache.set(wrappers[i], entry)
  }

  for (let i = wrappers.length; i < blocks.length; i++) {
    const wrapper = document.createElement('div')
    wrapper.dataset.msgIdx = String(i)
    wrapper.innerHTML = renderBlockHtml(blocks[i])
    _blockCache.set(wrapper, blockCacheEntry(blocks[i]))
    container.insertBefore(wrapper, indicator)
  }

  const indicatorHtml = renderIndicatorHtml(isStreaming)
  if (_indicatorCache.get(indicator) !== indicatorHtml) {
    indicator.innerHTML = indicatorHtml
    _indicatorCache.set(indicator, indicatorHtml)
  }
}
