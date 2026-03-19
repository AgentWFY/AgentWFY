import { escapeHtml, formatDate } from './chat_utils.js'
interface SessionListItem {
  label: string
  updatedAt: number
  isActive: boolean
  isStreaming: boolean
  file: string | null
  sessionId: string | null
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
