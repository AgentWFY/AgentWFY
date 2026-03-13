import { renderMarkdown } from '../markdown.js'
import type { AgentMessage, RetryInfo } from '../agent/types.js'
import { COMPACTION_SUMMARY_CUSTOM_TYPE } from '../agent/create_agent.js'
import { escapeHtml } from './chat_utils.js'
import type { TlJson } from './json_view.js'

interface ToolPair {
  name: string
  id: string
  arguments: unknown
  result: unknown
  isError: boolean
}

interface DisplayBlock {
  type: 'user' | 'assistant' | 'custom' | 'compaction'
  text: string
  tools: ToolPair[]
  compactionBeforeCount?: number
  raw: Record<string, unknown>
}

function getTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block: Record<string, unknown>) => block?.type === 'text')
      .map((block: Record<string, unknown>) => block.text as string)
      .join('')
  }
  return ''
}

function getToolCalls(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return []
  return content.filter((block: Record<string, unknown>) => block?.type === 'toolCall')
}

export function buildDisplayBlocks(msgs: AgentMessage[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i] as unknown as Record<string, unknown>
    if (msg.role === 'user') {
      blocks.push({ type: 'user', text: getTextFromContent(msg.content), tools: [], raw: msg })
      i++
    } else if (msg.role === 'assistant') {
      const text = getTextFromContent(msg.content)
      const toolCallsList = getToolCalls(msg.content)
      const tools: ToolPair[] = []
      let j = i + 1
      for (const tc of toolCallsList) {
        const pair: ToolPair = { name: tc.name as string, id: tc.id as string, arguments: tc.arguments, result: null, isError: false }
        const nextMsg = j < msgs.length ? (msgs[j] as unknown as Record<string, unknown>) : null
        if (nextMsg && nextMsg.role === 'toolResult' && nextMsg.toolCallId === tc.id) {
          pair.result = nextMsg.content
          pair.isError = nextMsg.isError as boolean
          j++
        }
        tools.push(pair)
      }
      blocks.push({ type: 'assistant', text, tools, raw: msg })
      i = j
    } else if (msg.role === 'toolResult') {
      i++
    } else if (msg.role === 'custom') {
      if (msg.customType === COMPACTION_SUMMARY_CUSTOM_TYPE) {
        const details = msg.details && typeof msg.details === 'object' ? msg.details as Record<string, unknown> : null
        const beforeCount = typeof details?.beforeCount === 'number' ? details.beforeCount : undefined
        blocks.push({
          type: 'compaction',
          text: getTextFromContent(msg.content),
          tools: [],
          compactionBeforeCount: beforeCount,
          raw: msg
        })
      } else {
        blocks.push({ type: 'custom', text: '', tools: [], raw: msg })
      }
      i++
    } else {
      i++
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

function getToolDescription(args: unknown): string {
  if (!args || typeof args !== 'object') return 'Executing code'
  const argsObj = args as Record<string, unknown>
  if (typeof argsObj.description === 'string' && argsObj.description.trim()) {
    return argsObj.description.trim()
  }
  return 'Executing code'
}

function getToolCode(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const argsObj = args as Record<string, unknown>
  return typeof argsObj.code === 'string' ? argsObj.code : ''
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
  const description = getToolDescription(tool.arguments)
  let html = `<div class="tool-header${isOpen ? ' open' : ''}" data-tool-id="${escapeHtml(tool.id)}">
    <span class="tool-description">${escapeHtml(description)}</span>
    ${tool.isError ? '<span class="tool-error-badge">error</span>' : ''}
  </div>`
  if (isOpen) {
    const code = getToolCode(tool.arguments)
    const { text: resultText, images } = formatToolResult(tool.result)
    html += '<div class="tool-body">'
    if (code) html += `<pre>${escapeHtml(code)}</pre>`
    if (resultText) html += `<pre class="${tool.isError ? 'tool-result-error' : ''}">${escapeHtml(resultText)}</pre>`
    if (images.length > 0) html += images.map(img => `<img src="data:${escapeHtml(img.mimeType)};base64,${img.data}">`).join('')
    html += '</div>'
  }
  return html
}

// --- Incremental DOM rendering ---

/** Cache last-set HTML per element to avoid browser innerHTML normalization issues */
const _htmlCache = new WeakMap<HTMLElement, string>()

function renderBlockHtml(block: DisplayBlock, index: number, openToolSet: Set<string>): string {
  if (block.type === 'user') {
    return `<div class="block block-user">${renderMarkdown(block.text)}</div>`
  }
  if (block.type === 'assistant') {
    const rawMsg = block.raw as { stopReason?: string; errorMessage?: string }
    const hasError = rawMsg.stopReason === 'error' && rawMsg.errorMessage
    if (!block.text.trim() && block.tools.length === 0 && !hasError) return ''
    let html = '<div class="block block-assistant">'
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
    if (hasError) {
      html += `<div class="error-banner">${escapeHtml(rawMsg.errorMessage!)}</div>`
    }
    html += '</div>'
    return html
  }
  if (block.type === 'compaction') {
    let html = '<div class="block block-compaction">'
    html += '<div class="compaction-label">[compaction]</div>'
    if (typeof block.compactionBeforeCount === 'number') {
      html += `<div class="compaction-meta">Compacted ${block.compactionBeforeCount.toLocaleString()} messages</div>`
    }
    if (block.text.trim()) {
      html += `<div class="assistant-text">${renderMarkdown(block.text)}</div>`
    }
    html += '</div>'
    return html
  }
  if (block.type === 'custom') {
    return `<div class="block block-custom"><tl-json data-block-idx="${index}"></tl-json></div>`
  }
  return ''
}

function renderIndicatorHtml(isStreaming: boolean, retryInfo: RetryInfo | null): string {
  if (!isStreaming) return ''
  if (retryInfo) {
    return `<div class="retry-indicator"><span class="retry-dot"></span> Reconnecting (${retryInfo.attempt}/${retryInfo.maxAttempts})...</div>`
  }
  return '<div class="thinking-dots"><span></span><span></span><span></span></div>'
}

function setupBlockCustomEl(wrapper: HTMLElement, block: DisplayBlock) {
  if (block.type !== 'custom') return
  const jsonEl = wrapper.querySelector('tl-json') as TlJson | null
  if (jsonEl) {
    jsonEl.json = block.raw.content
    jsonEl.placeholder = 'custom message'
  }
}

function setHtmlIfChanged(el: HTMLElement, html: string): boolean {
  if (_htmlCache.get(el) === html) return false
  el.innerHTML = html
  _htmlCache.set(el, html)
  return true
}

/**
 * Incrementally update the messages container DOM.
 * - Stable blocks are skipped (cached HTML matches)
 * - Only changed blocks (last block during streaming, toggled tools) are re-rendered
 * - New blocks are appended, excess blocks removed (compaction)
 */
export function updateMessagesEl(
  container: HTMLElement,
  blocks: DisplayBlock[],
  openToolSet: Set<string>,
  isStreaming: boolean,
  retryInfo: RetryInfo | null
): void {
  // Ensure indicator and anchor exist as persistent sentinel elements
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

  // Remove excess wrappers if block count shrank (compaction)
  for (let i = blocks.length; i < wrappers.length; i++) {
    wrappers[i].remove()
  }

  // Update existing wrappers — only touches DOM when HTML actually changed
  const existingCount = Math.min(wrappers.length, blocks.length)
  for (let i = 0; i < existingCount; i++) {
    const html = renderBlockHtml(blocks[i], i, openToolSet)
    if (setHtmlIfChanged(wrappers[i], html)) {
      setupBlockCustomEl(wrappers[i], blocks[i])
    }
  }

  // Append new blocks
  for (let i = wrappers.length; i < blocks.length; i++) {
    const wrapper = document.createElement('div')
    wrapper.dataset.msgIdx = String(i)
    const html = renderBlockHtml(blocks[i], i, openToolSet)
    wrapper.innerHTML = html
    _htmlCache.set(wrapper, html)
    container.insertBefore(wrapper, indicator)
    setupBlockCustomEl(wrapper, blocks[i])
  }

  // Update streaming indicator
  setHtmlIfChanged(indicator, renderIndicatorHtml(isStreaming, retryInfo))
}
