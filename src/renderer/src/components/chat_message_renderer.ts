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
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const tools: ToolPair[] = []
      let errorText = ''

      for (const block of msg.blocks) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'thinking') {
          thinkingParts.push(block.text)
        } else if (block.type === 'error') {
          errorText = block.text
        } else if (block.type === 'exec_js') {
          const resultBlock = msg.blocks.find(
            b => b.type === 'exec_js_result' && (b as Block & { type: 'exec_js_result' }).id === block.id
          )
          tools.push({
            id: block.id,
            description: block.description || 'Executing code',
            code: block.code,
            result: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.content : null,
            isError: resultBlock && resultBlock.type === 'exec_js_result' ? resultBlock.isError : false,
          })
        }
      }

      blocks.push({ type: 'assistant', text: textParts.join(''), thinking: thinkingParts.join(''), error: errorText, tools, ref: msg })
    }
  }

  return blocks
}

function extractImagesFromResult(result: unknown): { images: Array<{ data: string; mimeType: string }>; filteredResult: unknown } {
  const images: Array<{ data: string; mimeType: string }> = []
  if (!Array.isArray(result)) return { images, filteredResult: result }

  const filtered = result.filter((item: Record<string, unknown>) => {
    if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      images.push({ data: item.data, mimeType: item.mimeType })
      return false
    }
    return true
  })

  return { images, filteredResult: filtered }
}

function formatToolResult(result: unknown): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const { images, filteredResult } = extractImagesFromResult(result)
  if (!Array.isArray(filteredResult)) {
    return { text: typeof filteredResult === 'string' ? filteredResult : JSON.stringify(filteredResult, null, 2), images }
  }
  const textParts = filteredResult
    .filter((item: Record<string, unknown>) => item?.type === 'text')
    .map((item: Record<string, unknown>) => item.text as string)
  const text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(filteredResult, null, 2)
  return { text, images }
}

function renderToolHtml(tool: ToolPair, isOpen: boolean): string {
  let html = `<div class="tool-header${isOpen ? ' open' : ''}" data-tool-id="${escapeHtml(tool.id)}">
    <span class="tool-description">${escapeHtml(tool.description)}</span>
    ${tool.isError ? '<span class="tool-error-badge">error</span>' : ''}
  </div>`
  if (isOpen) {
    const { text: resultText, images } = formatToolResult(tool.result)
    html += '<div class="tool-body">'
    if (tool.code) html += `<pre>${escapeHtml(tool.code)}</pre>`
    if (resultText) html += `<pre class="${tool.isError ? 'tool-result-error' : ''}">${escapeHtml(resultText)}</pre>`
    if (images.length > 0) html += images.map(img => `<img src="data:${escapeHtml(img.mimeType)};base64,${img.data}">`).join('')
    html += '</div>'
  }
  return html
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
      html += `<div class="error-banner">${escapeHtml(block.error)}</div>`
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
