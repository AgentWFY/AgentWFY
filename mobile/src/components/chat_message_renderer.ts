// Pure helpers for turning DisplayMessage blocks into HTML. Matches the
// role of desktop/renderer/components/chat_message_renderer.ts — used by
// awfy-agent-chat to render the message list.

import type { Block, DisplayMessage } from '#shared/agent/provider_types.js'
import type { FileContent } from '#shared/agent/types.js'
import { escapeHtml, formatBytes } from './util.js'

export function renderMessagesHtml(messages: DisplayMessage[]): string {
  if (messages.length === 0) {
    return `<div class="empty-chat">No messages yet.</div>`
  }
  return messages.map(renderMessageHtml).join('')
}

function renderMessageHtml(message: DisplayMessage): string {
  const roleLabel = message.role === 'user' ? 'You' : 'Agent'
  return `
    <article class="chat-message" data-role="${message.role}">
      <div class="message-role">${roleLabel}</div>
      <div class="message-body">${message.blocks.map(renderBlockHtml).join('')}</div>
    </article>
  `
}

function renderBlockHtml(block: Block): string {
  switch (block.type) {
    case 'text':
      return `<div class="message-text">${escapeHtml(block.text)}</div>`
    case 'thinking':
      return `<details class="thinking-block"><summary>Thinking</summary><div class="message-text">${escapeHtml(block.text)}</div></details>`
    case 'file':
      return renderFileHtml({ type: 'file', data: block.data, mimeType: block.mimeType })
    case 'attachment':
      return `<div class="file-chip">${escapeHtml(block.label)} · ${formatBytes(block.size)}</div>`
    case 'exec_js':
      return `
        <details class="tool-card">
          <summary>${escapeHtml(block.description || 'Running JavaScript')}</summary>
          <pre>${escapeHtml(block.code)}</pre>
        </details>
      `
    case 'exec_js_result':
      return `
        <details class="tool-card ${block.isError ? 'is-error' : ''}">
          <summary>${block.isError ? 'JavaScript error' : 'JavaScript result'}</summary>
          <div class="tool-result">${block.content.map(renderToolContentHtml).join('')}</div>
        </details>
      `
    case 'error':
      return `<div class="message-error">${escapeHtml(block.text)}</div>`
  }
}

function renderToolContentHtml(content: FileContent | { type: 'text'; text: string }): string {
  if (content.type === 'file') return renderFileHtml(content)
  return `<pre>${escapeHtml(content.text)}</pre>`
}

function renderFileHtml(file: FileContent): string {
  if (file.mimeType.startsWith('image/')) {
    return `<img class="message-image" src="data:${escapeHtml(file.mimeType)};base64,${escapeHtml(file.data)}" alt="attachment">`
  }
  return `<div class="file-chip">${escapeHtml(file.mimeType)}</div>`
}
