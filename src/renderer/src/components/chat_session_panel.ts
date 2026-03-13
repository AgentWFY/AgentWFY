import { escapeHtml } from './chat_message_renderer.js'
import type { SessionListItem } from '../agent/session_manager.js'

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hours}:${mins}`
}

export function renderSessionPanelHtml(items: SessionListItem[]): string {
  let html = ''
  html += `<div class="session-panel-item${!items.some(i => i.isActive) ? ' active' : ''}" id="new-session-btn">
    <span class="session-panel-item-label">New session</span>
  </div>`
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    html += `<div class="session-panel-item${item.isActive ? ' active' : ''}" data-session-idx="${idx}">
      ${item.isStreaming ? '<span class="session-running-dot"></span>' : ''}
      <span class="session-panel-item-label">${escapeHtml(item.label)}</span>
      <span class="session-panel-item-date">${formatDate(item.updatedAt)}</span>
    </div>`
  }
  return html
}
