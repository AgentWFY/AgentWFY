import { renderMarkdown } from '../markdown.js'
import type { DisplayMessage, Block } from '../../../agent/provider_types.js'
import { escapeHtml } from './chat_utils.js'

interface ToolPair {
  id: string
  description: string
  code: string
  result: unknown
  isError: boolean
}

interface RenderBlock {
  type: 'user' | 'assistant'
  text: string
  thinking: string
  error: string
  tools: ToolPair[]
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
      blocks.push({ type: 'user', text, thinking: '', error: '', tools: [], ref: msg })
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

function renderFile(file: { data: string; mimeType: string }): string {
  if (file.mimeType.startsWith('image/')) {
    return `<img src="data:${escapeHtml(file.mimeType)};base64,${file.data}">`
  }
  return `<span class="file-badge">${escapeHtml(file.mimeType)}</span>`
}

function formatToolResult(result: unknown): { text: string; files: Array<{ data: string; mimeType: string }> } {
  const { files, filteredResult } = extractFilesFromResult(result)
  if (!Array.isArray(filteredResult)) {
    return { text: typeof filteredResult === 'string' ? filteredResult : JSON.stringify(filteredResult, null, 2), files }
  }
  const textParts = filteredResult
    .filter((item: Record<string, unknown>) => item?.type === 'text')
    .map((item: Record<string, unknown>) => item.text as string)
  const text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(filteredResult, null, 2)
  return { text, files }
}

function renderToolHtml(tool: ToolPair, isOpen: boolean): string {
  const headerHtml = `<div class="tool-header${isOpen ? ' open' : ''}" data-tool-id="${escapeHtml(tool.id)}">
    <span class="tool-description">${escapeHtml(tool.description)}</span>
    ${tool.isError ? '<span class="tool-error-badge">error</span>' : ''}
  </div>`
  if (!isOpen) return headerHtml
  const { text: resultText, files } = formatToolResult(tool.result)
  let bodyHtml = '<div class="tool-body">'
  if (tool.code) bodyHtml += `<pre>${escapeHtml(tool.code)}</pre>`
  if (resultText) bodyHtml += `<pre class="${tool.isError ? 'tool-result-error' : ''}">${escapeHtml(resultText)}</pre>`
  if (files.length > 0) bodyHtml += files.map(f => renderFile(f)).join('')
  bodyHtml += '</div>'
  return `<div class="tool-card">${headerHtml}${bodyHtml}</div>`
}

// --- Incremental DOM rendering ---

interface BlockCacheEntry {
  ref: DisplayMessage
  textLen: number
  thinkingLen: number
  toolCount: number
  toolResultCount: number
  toolOpenState: string
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
      : ''
  }
}

function blockCacheMatches(a: BlockCacheEntry, b: BlockCacheEntry): boolean {
  return a.ref === b.ref
    && a.textLen === b.textLen
    && a.thinkingLen === b.thinkingLen
    && a.toolCount === b.toolCount
    && a.toolResultCount === b.toolResultCount
    && a.toolOpenState === b.toolOpenState
}

function renderBlockHtml(block: RenderBlock, openToolSet: Set<string>): string {
  if (block.type === 'user') {
    return `<div class="block block-user">${renderMarkdown(block.text)}</div>`
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
