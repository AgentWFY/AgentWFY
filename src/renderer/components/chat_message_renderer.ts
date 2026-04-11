import { renderMarkdown } from '../markdown.js'
import type { DisplayMessage, Block } from '../../agent/provider_types.js'
import { escapeHtml, imageDataUrl } from './chat_utils.js'

interface ToolPair {
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

interface ParsedResult {
  value?: string
  error?: { name: string; message: string }
  logs: Array<{ level: string; message: string }>
  files: Array<{ data: string; mimeType: string }>
}

function parseToolResult(result: unknown): ParsedResult {
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

function renderResultBody(parsed: ParsedResult): string {
  let html = ''

  // Error section
  if (parsed.error) {
    html += '<div class="result-section">'
    html += '<div class="rs-label"><span class="rs-dot dot-error"></span> Error</div>'
    html += `<div class="error-block"><div class="error-name">${escapeHtml(parsed.error.name)}</div><div class="error-msg">${escapeHtml(parsed.error.message)}</div></div>`
    html += '</div>'
  }
  // Value section
  else if (parsed.value !== undefined) {
    html += '<div class="result-section">'
    html += '<div class="rs-label"><span class="rs-dot dot-value"></span> Return value</div>'
    html += `<pre>${escapeHtml(parsed.value)}</pre>`
    html += '</div>'
  }

  // Console logs section
  if (parsed.logs.length > 0) {
    html += '<div class="result-section">'
    html += `<div class="rs-label"><span class="rs-dot dot-log"></span> Console <span class="rs-meta">${parsed.logs.length} message${parsed.logs.length !== 1 ? 's' : ''}</span></div>`
    html += '<div class="log-list">'
    html += parsed.logs.map(renderLogEntry).join('')
    html += '</div></div>'
  }

  return html
}

function renderToolHtml(tool: ToolPair, isOpen: boolean): string {
  const headerHtml = `<div class="tool-header${isOpen ? ' open' : ''}" data-tool-id="${escapeHtml(tool.id)}">
    <span class="tool-description">${escapeHtml(tool.description)}</span>
    ${tool.isError ? '<span class="tool-error-badge">error</span>' : ''}
  </div>`
  if (!isOpen) return headerHtml

  const parsed = parseToolResult(tool.result)
  const hasError = tool.isError || !!parsed.error
  const imageFiles = parsed.files.filter(f => f.mimeType.startsWith('image/'))
  const nonImageFiles = parsed.files.filter(f => !f.mimeType.startsWith('image/'))
  const toolEid = escapeHtml(tool.id)

  // Build tabs — show Result/Error tab first when error
  const codeActive = !hasError
  let tabsHtml = '<div class="tb-tabs">'
  tabsHtml += `<div class="tb-tab${codeActive ? ' active' : ''}" data-tool-tab="${toolEid}" data-pane="code">Code</div>`
  const resultTabClass = hasError ? 'tb-tab tab-error' : 'tb-tab'
  tabsHtml += `<div class="${resultTabClass}${!codeActive ? ' active' : ''}" data-tool-tab="${toolEid}" data-pane="result">${hasError ? 'Error' : 'Result'}</div>`
  if (imageFiles.length > 0) {
    tabsHtml += `<div class="tb-tab" data-tool-tab="${toolEid}" data-pane="images">Image${imageFiles.length !== 1 ? 's' : ''} <span class="tb-badge">${imageFiles.length}</span></div>`
  }
  tabsHtml += '</div>'

  // Code pane
  const codePaneHtml = `<div class="tb-pane${codeActive ? ' active' : ''}" data-tool-pane="${toolEid}" data-pane="code">${tool.code ? `<pre>${escapeHtml(tool.code)}</pre>` : ''}</div>`

  // Result pane
  const resultContent = renderResultBody(parsed)
  const resultPaneHtml = `<div class="tb-pane${!codeActive ? ' active' : ''}" data-tool-pane="${toolEid}" data-pane="result">${resultContent || '<pre class="tool-result-empty">No output</pre>'}</div>`

  // Images pane
  let imagesPaneHtml = ''
  if (imageFiles.length > 0) {
    const imagesContent = imageFiles.map(f => {
      const ext = f.mimeType.split('/')[1]?.toUpperCase() || 'IMG'
      return `<div class="tb-img-wrap"><img src="${imageDataUrl(f.mimeType, f.data)}"><div class="tb-img-meta"><span class="pill">${escapeHtml(ext)}</span></div></div>`
    }).join('')
    imagesPaneHtml = `<div class="tb-pane" data-tool-pane="${toolEid}" data-pane="images">${imagesContent}</div>`
  }

  const nonImageHtml = nonImageFiles.map(f => `<span class="file-badge">${escapeHtml(f.mimeType)}</span>`).join('')

  return `<div class="tool-card">${headerHtml}${tabsHtml}<div class="tool-body">${codePaneHtml}${resultPaneHtml}${imagesPaneHtml}</div>${nonImageHtml}</div>`
}

// --- Incremental DOM rendering ---

interface BlockCacheEntry {
  ref: DisplayMessage
  textLen: number
  thinkingLen: number
  toolCount: number
  toolResultCount: number
  toolOpenState: string
  fileCount: number
}

const _blockCache = new WeakMap<HTMLElement, BlockCacheEntry>()
const _indicatorCache = new WeakMap<HTMLElement, string>()

function blockCacheEntry(block: RenderBlock, openToolSet: Set<string>): BlockCacheEntry {
  return {
    ref: block.ref,
    textLen: block.text.length,
    thinkingLen: block.thinking.length,
    toolCount: block.tools.length,
    toolResultCount: block.tools.reduce((n, t) => n + (t.result !== null ? 1 : 0), 0),
    toolOpenState: block.tools.length > 0
      ? block.tools.map(t => openToolSet.has(t.id) ? '1' : '0').join('')
      : '',
    fileCount: block.files.length,
  }
}

function blockCacheMatches(a: BlockCacheEntry, b: BlockCacheEntry): boolean {
  return a.ref === b.ref
    && a.textLen === b.textLen
    && a.thinkingLen === b.thinkingLen
    && a.toolCount === b.toolCount
    && a.toolResultCount === b.toolResultCount
    && a.toolOpenState === b.toolOpenState
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

function renderBlockHtml(block: RenderBlock, openToolSet: Set<string>): string {
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
        html += renderToolHtml(tool, openToolSet.has(tool.id))
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
  openToolSet: Set<string>,
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
    const entry = blockCacheEntry(blocks[i], openToolSet)
    const cached = _blockCache.get(wrappers[i])
    if (cached && blockCacheMatches(cached, entry)) continue
    wrappers[i].innerHTML = renderBlockHtml(blocks[i], openToolSet)
    _blockCache.set(wrappers[i], entry)
  }

  for (let i = wrappers.length; i < blocks.length; i++) {
    const wrapper = document.createElement('div')
    wrapper.dataset.msgIdx = String(i)
    wrapper.innerHTML = renderBlockHtml(blocks[i], openToolSet)
    _blockCache.set(wrapper, blockCacheEntry(blocks[i], openToolSet))
    container.insertBefore(wrapper, indicator)
  }

  const indicatorHtml = renderIndicatorHtml(isStreaming)
  if (_indicatorCache.get(indicator) !== indicatorHtml) {
    indicator.innerHTML = indicatorHtml
    _indicatorCache.set(indicator, indicatorHtml)
  }
}
