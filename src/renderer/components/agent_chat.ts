import {
  buildRenderBlocks,
  updateMessagesEl,
  findToolPair,
  renderToolDetailsHtml,
  renderToolStatusPillHtml,
  resolveToolCopyText,
  parseToolResult,
  type ToolPair,
} from './chat_message_renderer.js'
import { parseTabLink, copyToButton, CLOSE_ICON_SVG } from './chat_utils.js'
import { agentSessionStore } from '../stores/agent-session-store.js'
import type { TlChatInput } from './chat_input.js'
import type { TlTracePanel } from './trace_panel.js'

const ATTACH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48"/></svg>'
const NOTIFY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
const HISTORY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>'
const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
const TRACE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l3-8 4 16 3-8h5"/></svg>'

function makeIconBtn(title: string, html: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'icon-btn'
  btn.title = title
  btn.innerHTML = html
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    onClick()
  })
  return btn
}

const STYLES = `
  awfy-agent-chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .container {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    padding: 10px;
    box-sizing: border-box;
    position: relative;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-anchor: none;
  }
  .messages * { overflow-anchor: none; }
  .messages #anchor { height: 1px; }
  .block {
    user-select: text;
    word-break: break-word;
  }
  .messages > [data-msg-idx] {
    content-visibility: auto;
    contain-intrinsic-size: auto 80px;
  }
  .block-user {
    margin: 8px 0;
  }
  .block p { margin: 0.4em 0; }
  .block p:last-child { margin-bottom: 0; }
  .block p:first-child { margin-top: 0; }

  /* Inline code */
  .block code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--color-code-bg);
    word-break: break-all;
  }

  /* Code blocks */
  .block pre {
    margin: 6px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-code-bg);
    overflow-x: auto;
    line-height: 1.45;
  }
  .block pre code {
    padding: 0;
    background: none;
    font-size: 12px;
    white-space: pre;
    word-break: normal;
  }

  /* Headings */
  .block h1, .block h2, .block h3,
  .block h4, .block h5, .block h6 {
    margin: 0.6em 0 0.3em;
    line-height: 1.3;
    color: var(--color-text4);
  }
  .block h1 { font-size: 1.3em; }
  .block h2 { font-size: 1.15em; }
  .block h3 { font-size: 1.05em; }
  .block h4, .block h5, .block h6 { font-size: 1em; }
  .block h1:first-child, .block h2:first-child, .block h3:first-child { margin-top: 0; }

  /* Lists */
  .block ul, .block ol {
    margin: 0.3em 0;
    padding-left: 1.5em;
  }
  .block li { margin: 2px 0; }
  .block li > ul, .block li > ol { margin: 2px 0; }
  .block li input[type="checkbox"] {
    margin: 0 4px 0 0;
    vertical-align: middle;
    pointer-events: none;
  }

  /* Blockquotes */
  .block blockquote {
    margin: 0.4em 0;
    padding: 2px 0 2px 10px;
    border-left: 3px solid var(--color-divider);
    color: var(--color-text1);
  }
  .block blockquote p:first-child { margin-top: 0; }
  .block blockquote p:last-child { margin-bottom: 0; }

  /* Tables */
  .block table {
    border-collapse: collapse;
    margin: 0.5em 0;
    font-size: 12px;
    width: 100%;
    display: block;
    overflow-x: auto;
  }
  .block th, .block td {
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    text-align: left;
  }
  .block th {
    background: var(--color-bg3);
    font-weight: 600;
    color: var(--color-text4);
    white-space: nowrap;
  }
  .block tr:nth-child(even) td {
    background: var(--color-bg2);
  }

  /* Horizontal rule */
  .block hr {
    border: none;
    border-top: 1px solid var(--color-divider);
    margin: 0.6em 0;
  }

  /* Links */
  .block a {
    color: var(--color-accent);
    text-decoration: none;
  }
  .block a:hover {
    text-decoration: underline;
  }

  /* Images */
  .block img {
    max-width: 100%;
    border-radius: var(--radius-sm);
    margin: 4px 0;
  }

  /* Strikethrough */
  .block del {
    color: var(--color-text2);
  }
  .block-user {
    background: #d0d0d0;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    color: var(--color-text4);
  }
  @media (prefers-color-scheme: dark) {
    .block-user { background: #3a3a3a; }
  }
  .block-user .user-files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .block-user .user-files:first-child {
    margin-top: 0;
  }
  .block-user .user-file-image {
    max-width: 240px;
    max-height: 200px;
    margin: 0;
    border-radius: var(--radius-sm);
    display: block;
  }
  .awfy-app-root.zen-mode .block-user .user-file-image {
    cursor: zoom-in;
  }
  .assistant-text { padding: 2px 0; }
  .thinking-text {
    padding: 2px 0;
    color: var(--color-text2);
    font-style: italic;
    font-size: 12px;
    border-left: 2px solid var(--color-border);
    padding-left: 8px;
    margin-bottom: 4px;
  }
  .tools-group {
    margin-top: 2px;
  }
  /* ── Tool row ── */
  .tool-header {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 1px 0;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    color: var(--color-text2);
    border-radius: 3px;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tool-header:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .tool-description {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-error-badge {
    font-size: 10px;
    color: var(--color-red-fg);
    flex-shrink: 0;
  }
  .log-entry {
    padding: 0 8px;
    display: flex;
    gap: 6px;
  }
  .log-entry:hover { background: var(--color-item-hover); }
  .log-level {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    flex-shrink: 0;
    width: 32px;
    text-align: right;
    padding-top: 1px;
  }
  .l-log { color: var(--color-text2); }
  .l-info { color: var(--color-accent); }
  .l-warn { color: var(--color-yellow-fg); }
  .l-error { color: var(--color-red-fg); }
  .log-msg {
    color: var(--color-text3);
    word-break: break-word;
    min-width: 0;
  }
  .awfy-app-root.zen-mode .tp-img-wrap img {
    cursor: zoom-in;
  }
  .image-lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.88);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: zoom-out;
    padding: 24px;
    box-sizing: border-box;
    animation: lightbox-fade 120ms ease-out;
  }
  .image-lightbox-overlay img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }
  @keyframes lightbox-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .file-badge {
    display: inline-block;
    padding: 2px 8px;
    margin: 4px 10px;
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text2);
    background: var(--color-bg3);
    border-radius: var(--radius-sm);
  }
  .tool-popup {
    flex: 1;
    min-height: 0;
    min-width: 0;
    background: transparent;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: tp-fade 140ms ease-out;
  }
  .tool-popup[hidden] { display: none; }
  @keyframes tp-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .tool-popup-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 12px;
    border-bottom: 1px solid var(--color-divider);
    flex-shrink: 0;
    min-height: 28px;
  }
  .tool-popup-description {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--color-text4);
    font-weight: 600;
    letter-spacing: -0.1px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-popup-pills {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  /* Status: minimal text-only — no pill background */
  .tp-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .tp-status.ok  { color: var(--color-text2); }
  .tp-status.err { color: var(--color-red-fg); }
  .tp-status .tp-status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }
  .tp-status.ok .tp-status-dot { background: var(--color-green-fg); }
  .tp-status.running .tp-status-dot {
    background: var(--color-text2);
    animation: tp-pulse 1.4s ease-in-out infinite;
  }
  @keyframes tp-pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 1; }
  }
  .tool-popup-close {
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
  .tool-popup-close:hover {
    background: var(--color-item-hover);
    color: var(--color-text4);
  }
  .tool-popup-close svg { display: block; }
  .tool-popup-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px 12px 14px;
    scrollbar-gutter: stable;
    user-select: text;
  }
  /* Error: subtle, text-led — no card */
  .tp-error-card {
    margin: 0 0 12px;
    padding: 6px 10px;
    background: var(--color-red-bg);
    border-left: 2px solid var(--color-red-fg);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .tp-error-card .tp-error-name {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-red-fg);
    margin-bottom: 2px;
  }
  .tp-error-card .tp-error-msg {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-red-fg);
    line-height: 1.45;
    word-break: break-word;
    white-space: pre-wrap;
    opacity: 0.9;
  }
  .tp-section {
    margin-bottom: 12px;
  }
  .tp-section:last-child { margin-bottom: 0; }
  .tp-section-label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text2);
    line-height: 1.3;
  }
  .tp-section-side {
    margin-left: auto;
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }
  .tp-section:hover .tp-section-side,
  .tp-section:focus-within .tp-section-side {
    opacity: 1;
  }
  .tp-section-side .tp-trunc-pill { opacity: 1; }
  .tp-section-meta {
    font-weight: 400;
    font-size: 11px;
    color: var(--color-text2);
    font-variant-numeric: tabular-nums;
    opacity: 1;
  }
  .tp-block {
    margin: 0;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-bg2);
    color: var(--color-text4);
    border: none;
    border-radius: var(--radius-sm);
    overflow: auto;
    max-height: 280px;
  }
  .tp-block.tp-value { color: var(--color-text3); }
  .tp-trunc-pill {
    font-size: 10px;
    font-weight: 400;
    color: var(--color-text2);
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-style: italic;
  }
  .tp-copy {
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
  .tp-copy:hover { color: var(--color-text4); }
  .tp-copy.copied { color: var(--color-green-fg); }
  .tp-logs {
    background: var(--color-bg2);
    border: none;
    border-radius: var(--radius-sm);
    padding: 5px 0;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.55;
    max-height: 240px;
    overflow: auto;
  }
  .tp-logs .log-entry {
    padding: 0 10px;
  }
  .tp-logs .log-level {
    width: 32px;
  }
  .tp-images {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tp-img-wrap {
    margin: 0;
    border: none;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--color-bg2);
  }
  .tp-img-wrap img {
    display: block;
    width: 100%;
    max-width: 100%;
  }
  .tp-img-meta {
    padding: 5px 9px;
    font-size: 10px;
    color: var(--color-text2);
    background: var(--color-bg3);
    display: flex;
    gap: 6px;
  }
  .tp-img-pill {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 600;
    background: var(--color-bg1);
    color: var(--color-text2);
  }
  .tp-files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tp-file-badge {
    display: inline-block;
    padding: 2px 7px;
    font-size: 11px;
    color: var(--color-text2);
    background: var(--color-bg2);
    border: none;
    border-radius: var(--radius-sm);
  }
  .tp-empty {
    padding: 32px 16px;
    text-align: center;
    color: var(--color-text2);
    font-size: 12px;
  }
  .tp-empty-inline {
    padding: 8px 10px;
    background: var(--color-bg2);
    color: var(--color-text2);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 11px;
  }
  .block-custom {
    font-size: 12px;
    color: var(--color-text2);
    padding: 2px 0;
  }
  .block-compaction {
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
  }
  .compaction-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text2);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .compaction-meta {
    font-size: 11px;
    color: var(--color-text2);
    margin-bottom: 6px;
  }
  .input-area {
    margin-top: 10px;
    flex-shrink: 0;
    position: relative;
  }
  .composer {
    background: var(--color-input-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    overflow: hidden;
    transition: border-color var(--transition-fast);
  }
  .composer:focus-within {
    border-color: var(--color-focus-border);
  }
  .composer-bar {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 3px 2px 3px;
  }
  .composer-bar .spacer { flex: 1; }
  .composer-status {
    display: block;
    padding: 3px 10px 4px 10px;
    font-size: 10.5px;
    line-height: 1.35;
    border-top: 1px solid var(--color-divider);
    background: var(--color-bg2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text2);
  }
  .composer-status .provider-name {
    color: var(--color-text4);
    font-weight: 600;
  }
  .composer-status .provider-stats {
    color: var(--color-text1);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
  }
  .icon-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--color-text2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
    padding: 0;
    position: relative;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .icon-btn:hover {
    background: var(--color-item-hover);
    color: var(--color-text4);
  }
  .icon-btn svg {
    width: 13px;
    height: 13px;
    display: block;
  }
  .icon-btn.active { color: var(--color-accent); }
  .icon-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-red-fg);
    border: 2px solid var(--color-input-bg);
    display: none;
  }
  .icon-btn.active .icon-badge { display: block; }
  .composer-stop {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px 0 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text4);
    background: var(--color-bg3);
    border: 1px solid var(--color-border);
    border-radius: 5px;
    cursor: pointer;
  }
  .composer-stop:hover { background: var(--color-item-hover); }
  .composer-stop-sq {
    width: 7px;
    height: 7px;
    border-radius: 1.5px;
    background: var(--color-red-fg);
    flex-shrink: 0;
  }
  .error-banner {
    color: var(--color-red-fg);
    padding: 6px 10px;
    margin: 6px 0;
    background: var(--color-red-bg);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .retry-banner {
    padding: 8px 12px;
    background: var(--color-yellow-bg, var(--color-bg2));
    color: var(--color-yellow-fg, var(--color-text3));
    border-radius: var(--radius-sm);
    margin: 6px 0;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .retry-banner .retry-text { flex: 1; }
  .retry-banner .retry-error {
    font-size: 11px;
    opacity: 0.8;
    margin-top: 2px;
  }
  .retry-banner .retry-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .retry-banner button {
    font-size: 11px;
    padding: 3px 10px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg1);
    color: var(--color-text3);
  }
  .retry-banner button:hover { background: var(--color-bg2); }
  .initializing {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text2);
  }
  .scroll-to-bottom {
    position: sticky;
    bottom: 8px;
    display: none;
    align-items: center;
    gap: 4px;
    padding: 5px 14px;
    background: var(--color-bg1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    color: var(--color-text3);
    font-size: 11px;
    font-weight: 500;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    width: fit-content;
    margin: 0 auto;
  }
  .scroll-to-bottom:hover {
    background: var(--color-bg2);
    color: var(--color-text4);
  }
  .scroll-to-bottom svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
  .thinking-dots {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 2px;
  }
  .thinking-dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    animation: thinking 1.4s ease-in-out infinite;
  }
  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
  .streaming-phase-label {
    font-size: 12px;
    color: var(--color-text2);
    padding: 6px 2px;
    animation: phasePulse 2s ease-in-out infinite;
  }
  @keyframes phasePulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 0.9; }
  }
  @keyframes thinking {
    0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }
  .retry-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 2px;
    font-size: 12px;
    color: var(--color-text2);
  }
  .retry-indicator span.retry-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-text2);
    animation: thinking 1.4s ease-in-out infinite;
  }
`

export class TlAgentChat extends HTMLElement {
  private _unsubs: (() => void)[] = []
  private error: string | null = null
  private isInitializing = true
  private messagesEl: HTMLElement | null = null
  private containerEl!: HTMLDivElement
  private styleEl!: HTMLStyleElement
  private _toolPopupEl: HTMLElement | null = null
  private _toolPopupDescription: HTMLElement | null = null
  private _toolPopupPills: HTMLElement | null = null
  private _toolPopupBody: HTMLElement | null = null
  private _activeToolId: string | null = null
  private _activeToolSig: string | null = null
  /** Single source of truth for which view owns the messages flex slot. */
  private _inlineSlot: 'messages' | 'trace' | 'tool' = 'messages'
  private static readonly SCROLL_THRESHOLD = 4
  private userScrolledUp = false
  private _programmaticScrollCount = 0
  private _scrollToBottomBtn: HTMLElement | null = null
  private _scrollBtnVisible = false
  private _renderMode: 'initializing' | 'chat' | null = null
  private _errorBanner: HTMLElement | null = null
  private _retryBanner: HTMLElement | null = null
  private _retryCountdownTimer: ReturnType<typeof setInterval> | null = null
  private _currentPhase: string | null = null
  private _phaseStartTime: number = 0
  private _phaseLabelTimer: ReturnType<typeof setInterval> | null = null
  private _lastStreamingBlockCount: number = 0
  private _lastStreamingText: string | null = null
  private _lastStreamEventTime: number = 0
  private _updateMessagesPending: number | null = null
  private _notifyBtn: HTMLElement | null = null
  private _settingsBtn: HTMLElement | null = null
  private _stopBtn: HTMLElement | null = null
  private _statusEl: HTMLElement | null = null
  private _statusProviderEl: HTMLElement | null = null
  private _statusStatsEl: HTMLElement | null = null
  private _providerGridEl: HTMLElement | null = null
  private _sessionTabsEl: HTMLElement | null = null
  private _chatInputEl: TlChatInput | null = null
  private _traceBtn: HTMLElement | null = null
  private _tracePanelEl: TlTracePanel | null = null
  private _closeLightbox: (() => void) | null = null
  private _isZenMode = false
  private _unlistenZenMode: (() => void) | null = null

  // Per-agent state cache (scroll & tool state only — input state is in chat-input)
  private _chatStateCache = new Map<string, { userScrolledUp: boolean }>()
  private _currentAgentRoot: string | null = null

  // Per-session scroll cache — only populated when the user scrolled up;
  // at-bottom is represented by absence (auto-scroll handles it).
  private _sessionScrollCache = new Map<string, { scrollTop: number }>()
  private _currentSessionFile: string | null = null
  private _pendingScrollTarget: number | null = null

  connectedCallback() {
    this.style.display = 'flex'
    this.style.flexDirection = 'column'
    this.style.flex = '1 1 auto'
    this.style.height = '100%'
    this.style.minHeight = '0'

    this.styleEl = document.createElement('style')
    this.styleEl.textContent = STYLES
    this.appendChild(this.styleEl)

    this.containerEl = document.createElement('div')
    this.containerEl.style.display = 'flex'
    this.containerEl.style.flexDirection = 'column'
    this.containerEl.style.flex = '1 1 auto'
    this.containerEl.style.minHeight = '0'
    this.appendChild(this.containerEl)

    this._currentAgentRoot = window.ipc?.agentRoot ?? null
    this.render()
    this.init()
  }

  focusInput() {
    (this._chatInputEl as any)?.focusInput?.()
  }

  disconnectedCallback() {
    window.removeEventListener('agentwfy:open-session-in-chat', this.onOpenSessionInChat)
    window.removeEventListener('agentwfy:load-session', this.onLoadSession)
    window.removeEventListener('agentwfy:agent-switched', this.onAgentSwitched)
    this._unlistenZenMode?.()
    this._unlistenZenMode = null
    window.removeEventListener('agentwfy:close-current-session', this.onCloseCurrentSession)
    window.removeEventListener('agentwfy:switch-to-session', this.onSwitchToSession)
    window.removeEventListener('agentwfy:cycle-session', this.onCycleSession)
    document.removeEventListener('keydown', this.onPopupKeydown, true)
    this._closeLightbox?.()
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
    if (this._updateMessagesPending !== null) {
      cancelAnimationFrame(this._updateMessagesPending)
      this._updateMessagesPending = null
    }
    this.clearChatRefs()
    this._renderMode = null
  }

  private onOpenSessionInChat = (e: Event) => {
    const { file, label } = (e as CustomEvent<{ file: string; label: string }>).detail
    if (file) {
      agentSessionStore.addOpenSession(file, label || 'Session')
    }
    window.dispatchEvent(new CustomEvent('agentwfy:open-sidebar-panel', { detail: { panel: 'agent-chat' } }))
  }

  private onLoadSession = (e: Event) => {
    const { file, label } = (e as CustomEvent<{ file: string; label: string }>).detail
    if (!file) return
    agentSessionStore.addOpenSession(file, label || 'Session')
    this.loadSession(file)
    window.dispatchEvent(new CustomEvent('agentwfy:open-sidebar-panel', { detail: { panel: 'agent-chat' } }))
  }

  private onAgentSwitched = (e: Event) => {
    const detail = (e as CustomEvent).detail
    const newAgentRoot: string | null = detail?.agentRoot ?? null
    const agents: Array<{ path: string }> | undefined = detail?.agents

    if (newAgentRoot === this._currentAgentRoot) return

    if (this._currentAgentRoot) {
      this._chatStateCache.set(this._currentAgentRoot, {
        userScrolledUp: this.userScrolledUp,
      })
    }

    const cached = newAgentRoot ? this._chatStateCache.get(newAgentRoot) : null
    if (cached) {
      this.userScrolledUp = cached.userScrolledUp
    } else {
      this.userScrolledUp = false
    }
    this.closeToolPopup()
    this._tracePanelEl?.close()

    if (agents) {
      const activePaths = new Set(agents.map(a => a.path))
      for (const key of this._chatStateCache.keys()) {
        if (!activePaths.has(key)) this._chatStateCache.delete(key)
      }
    }

    this.error = null
    this._currentAgentRoot = newAgentRoot
  }

  private onCloseCurrentSession = () => {
    const s = agentSessionStore.state
    if (s.activeSessionFile) {
      agentSessionStore.removeOpenSession(s.activeSessionFile)
    }
  }

  private onSwitchToSession = (e: Event) => {
    const { index } = (e as CustomEvent<{ index: number }>).detail
    const open = agentSessionStore.state.openSessions
    if (index >= 0 && index < open.length) {
      const session = open[index]
      if (session.file !== agentSessionStore.state.activeSessionFile) {
        this.loadSession(session.file)
      }
    }
  }

  private onCycleSession = (e: Event) => {
    const { direction } = (e as CustomEvent<{ direction: number }>).detail
    const open = agentSessionStore.state.openSessions
    if (open.length <= 1) return
    const activeFile = agentSessionStore.state.activeSessionFile
    const currentIdx = open.findIndex(s => s.file === activeFile)
    const nextIdx = (currentIdx + direction + open.length) % open.length
    const session = open[nextIdx]
    if (session && session.file !== activeFile) {
      this.loadSession(session.file)
    }
  }

  private init() {
    window.addEventListener('agentwfy:open-session-in-chat', this.onOpenSessionInChat)
    window.addEventListener('agentwfy:load-session', this.onLoadSession)
    window.addEventListener('agentwfy:agent-switched', this.onAgentSwitched)
    this._unlistenZenMode = window.ipc?.zenMode?.onChanged((isZen: boolean) => {
      this._isZenMode = isZen
    }) ?? null
    window.addEventListener('agentwfy:close-current-session', this.onCloseCurrentSession)
    window.addEventListener('agentwfy:switch-to-session', this.onSwitchToSession)
    window.addEventListener('agentwfy:cycle-session', this.onCycleSession)
    document.addEventListener('keydown', this.onPopupKeydown, true)

    if (!window.ipc?.agent) {
      this.isInitializing = false
      this.render()
      return
    }

    // Subscribe to targeted store slices instead of blanket subscribe()
    this.subscribeToStore()

    // Wait for the store to be ready
    if (agentSessionStore.state.ready) {
      this.isInitializing = false
    }

    this.render()
  }

  private scheduleUpdateMessages() {
    if (this._updateMessagesPending !== null) return
    this._updateMessagesPending = requestAnimationFrame(() => {
      this._updateMessagesPending = null
      this.updateMessages()
    })
  }

  private subscribeToStore() {
    this._unsubs.push(agentSessionStore.select(
      s => s.activeSessionFile,
      (newFile) => this.onActiveSessionFileChanged(newFile)
    ))

    this._unsubs.push(agentSessionStore.select(
      s => s.activeSessionId,
      () => this.updateTraceBtn()
    ))

    // Streaming message deltas (hot path) — only update messages area
    this._unsubs.push(agentSessionStore.select(
      s => s.streamingMessage,
      () => this.scheduleUpdateMessages()
    ))

    // Messages array changed (new messages, session loaded)
    this._unsubs.push(agentSessionStore.select(
      s => s.messages,
      () => {
        this.error = null
        this.scheduleUpdateMessages()
        this.updateProviderGridVisibility()
      }
    ))

    // Streaming state toggled (start/stop)
    this._unsubs.push(agentSessionStore.select(
      s => s.isStreaming,
      () => {
        this.error = null
        this.scheduleUpdateMessages()
        this.updateProviderGridVisibility()
        this.updateNotifyBtn()
        this.updateStopBtn()
        this.updateScrollToBottomBtn()
      }
    ))

    // Ready state
    this._unsubs.push(agentSessionStore.select(
      s => s.ready,
      (ready) => {
        if (ready && this.isInitializing) {
          this.isInitializing = false
          this.render()
        }
      }
    ))

    // Retry state
    this._unsubs.push(agentSessionStore.select(
      s => s.retryState,
      () => this.updateRetryBanner()
    ))

    // Notify state
    this._unsubs.push(agentSessionStore.select(
      s => s.notifyOnFinish,
      () => this.updateNotifyBtn()
    ))

    // Provider info — selector returns a change-detection key; listener re-reads state
    this._unsubs.push(agentSessionStore.select(
      s => {
        const hasMessages = s.messages.length > 0 || s.isStreaming
        const providerId = hasMessages ? s.providerId : s.selectedProviderId
        const provider = s.providerList.find(p => p.id === providerId)
        const name = provider?.name || providerId || ''
        const status = hasMessages
          ? (s.statusLine || s.configStatusLine)
          : (s.providerStatusLines.get(providerId) || '')
        return `${name}\0${status}`
      },
      () => this.updateStatus()
    ))
  }

  // ── Retry banner ──

  private updateRetryBanner() {
    if (!this._retryBanner) return
    const retryState = agentSessionStore.state.retryState
    if (retryState) {
      this._retryBanner.style.display = ''
      this.renderRetryBannerContent(retryState)
    } else {
      this._retryBanner.style.display = 'none'
      if (this._retryCountdownTimer) {
        clearInterval(this._retryCountdownTimer)
        this._retryCountdownTimer = null
      }
    }
  }

  private renderRetryBannerContent(retryState: { attempt: number; maxAttempts: number; nextRetryAt: number; lastError: string; category: string }) {
    if (!this._retryBanner) return

    if (!this._retryBanner.querySelector('.retry-text')) {
      this._retryBanner.innerHTML = `
        <div class="retry-text">
          <div class="retry-countdown"></div>
          <div class="retry-error"></div>
        </div>
        <div class="retry-actions">
          <button data-action="retry-now">Retry now</button>
          <button data-action="stop-retry">Stop</button>
        </div>
      `
      this._retryBanner.onclick = (e) => {
        const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
        if (!target) return
        const action = target.dataset.action
        if (action === 'retry-now') agentSessionStore.retryNow()
        else if (action === 'stop-retry') agentSessionStore.abort()
      }
    }

    const countdownEl = this._retryBanner.querySelector('.retry-countdown') as HTMLElement
    const errorEl = this._retryBanner.querySelector('.retry-error') as HTMLElement

    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((retryState.nextRetryAt - Date.now()) / 1000))
      countdownEl.textContent = `Retrying in ${remaining}s\u2026 (attempt ${retryState.attempt}/${retryState.maxAttempts})`
    }

    updateCountdown()
    errorEl.textContent = retryState.lastError

    if (this._retryCountdownTimer) clearInterval(this._retryCountdownTimer)
    this._retryCountdownTimer = setInterval(updateCountdown, 1000)
  }

  // ── Streaming phase indicator ──

  private static PHASE_THRESHOLD_MS = 30_000
  private static DOTS_HTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>'

  private getCurrentPhase(s: typeof agentSessionStore.state): string | null {
    if (!s.isStreaming || s.retryState) return null

    const blocks = s.streamingMessage?.blocks
    if (!blocks || blocks.length === 0) return 'waiting'

    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock.type === 'exec_js') return 'tool'

    const lastText = lastBlock.type === 'text' ? (lastBlock as { text: string }).text : null
    if (blocks.length !== this._lastStreamingBlockCount || lastText !== this._lastStreamingText) {
      this._lastStreamingBlockCount = blocks.length
      this._lastStreamingText = lastText
      this._lastStreamEventTime = Date.now()
    }

    if (Date.now() - this._lastStreamEventTime > TlAgentChat.PHASE_THRESHOLD_MS) {
      return 'idle'
    }

    return 'streaming'
  }

  private getPhaseLabel(phase: string, elapsed: number): string {
    const secs = Math.round(elapsed / 1000)
    switch (phase) {
      case 'waiting': return `Waiting for response ${secs}s`
      case 'tool': return `Running code ${secs}s`
      case 'idle': return `Waiting for response ${secs}s`
      default: return ''
    }
  }

  private updatePhaseLabel(s: typeof agentSessionStore.state): void {
    if (!this.messagesEl) return
    const indicator = this.messagesEl.querySelector<HTMLElement>('#streaming-indicator')
    if (!indicator) return

    const phase = this.getCurrentPhase(s)

    if (phase !== this._currentPhase) {
      this._currentPhase = phase
      this._phaseStartTime = phase === 'idle' ? this._lastStreamEventTime : Date.now()
      this.clearPhaseLabelTimer()
      indicator.innerHTML = phase ? TlAgentChat.DOTS_HTML : ''

      if (phase) {
        this.startPhaseLabelTimer(indicator)
      }
    }
  }

  private startPhaseLabelTimer(indicator: HTMLElement): void {
    this.clearPhaseLabelTimer()

    this._phaseLabelTimer = setInterval(() => {
      const phase = this.getCurrentPhase(agentSessionStore.state)

      if (phase !== this._currentPhase) {
        this._currentPhase = phase
        this._phaseStartTime = phase === 'idle' ? this._lastStreamEventTime : Date.now()
        indicator.innerHTML = phase ? TlAgentChat.DOTS_HTML : ''
        if (!phase) { this.clearPhaseLabelTimer(); return }
        return
      }

      if (!phase || phase === 'streaming') return

      const elapsed = Date.now() - this._phaseStartTime
      if (elapsed < TlAgentChat.PHASE_THRESHOLD_MS) return

      const label = this.getPhaseLabel(phase, elapsed)
      if (!label) return
      const existing = indicator.querySelector('.streaming-phase-label')
      if (existing) {
        existing.textContent = label
      } else {
        indicator.innerHTML = `<div class="streaming-phase-label">${label}</div>`
      }
    }, 1000)
  }

  private clearPhaseLabelTimer(): void {
    if (this._phaseLabelTimer) { clearInterval(this._phaseLabelTimer); this._phaseLabelTimer = null }
  }

  // ── Session actions ──

  private loadSession(file: string) {
    agentSessionStore.loadSession(file).catch(err => {
      this.error = err instanceof Error ? err.message : String(err)
      this.updateErrorBanner()
    })
  }

  // ── Image lightbox ──

  private openImageLightbox(src: string): void {
    if (!this._isZenMode) return

    this._closeLightbox?.()

    const overlay = document.createElement('div')
    overlay.className = 'image-lightbox-overlay'
    const img = document.createElement('img')
    img.src = src
    overlay.appendChild(img)

    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      this._closeLightbox = null
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        close()
      }
    }
    overlay.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
    this._closeLightbox = close
  }

  // ── Scroll management ──

  private onActiveSessionFileChanged(newFile: string | null): void {
    const openFiles = new Set(agentSessionStore.state.openSessions.map(s => s.file))
    // DOM still reflects the previous session here (messages re-render on rAF).
    if (this._currentSessionFile && this.messagesEl) {
      if (this.userScrolledUp && openFiles.has(this._currentSessionFile)) {
        this._sessionScrollCache.set(this._currentSessionFile, {
          scrollTop: this.messagesEl.scrollTop,
        })
      } else {
        this._sessionScrollCache.delete(this._currentSessionFile)
      }
    }
    for (const key of this._sessionScrollCache.keys()) {
      if (!openFiles.has(key)) this._sessionScrollCache.delete(key)
    }
    this._currentSessionFile = newFile
    this._tracePanelEl?.close()
    const cached = newFile ? this._sessionScrollCache.get(newFile) : null
    if (cached) {
      this.userScrolledUp = true
      this._pendingScrollTarget = cached.scrollTop
    } else {
      this.userScrolledUp = false
      this._pendingScrollTarget = null
    }
    this.updateScrollToBottomBtn()
  }

  private handleMessagesScroll = () => {
    if (!this.messagesEl || this._programmaticScrollCount > 0) return
    const distanceFromBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight
    this.userScrolledUp = distanceFromBottom > TlAgentChat.SCROLL_THRESHOLD
    this.updateScrollToBottomBtn()
  }

  private handleUserScrollIntent = (e: Event) => {
    if (!this.messagesEl || this.userScrolledUp) return
    if (e.type === 'wheel') {
      const we = e as WheelEvent
      if (we.deltaY >= 0) return
      if (this.messagesEl.scrollTop === 0) return
    }
    this.userScrolledUp = true
    this.updateScrollToBottomBtn()
  }

  private handleScrollKeydown = (e: KeyboardEvent) => {
    if ((e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') && !this.userScrolledUp) {
      if (this.messagesEl && this.messagesEl.scrollTop > 0) {
        this.userScrolledUp = true
        this.updateScrollToBottomBtn()
      }
    }
  }

  private scrollToBottom() {
    if (!this.messagesEl) return
    this._programmaticScrollCount++
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight
    requestAnimationFrame(() => { this._programmaticScrollCount-- })
  }

  private updateScrollToBottomBtn() {
    if (!this._scrollToBottomBtn) return
    const show = this.userScrolledUp && agentSessionStore.state.isStreaming
    if (show !== this._scrollBtnVisible) {
      this._scrollBtnVisible = show
      this._scrollToBottomBtn.style.display = show ? 'flex' : 'none'
    }
  }

  // ── Render lifecycle ──

  private render() {
    if (!this.containerEl) return

    const mode = (this.isInitializing || !agentSessionStore.state.ready) ? 'initializing' : 'chat'

    if (mode === 'initializing') {
      this.clearChatRefs()
      this.containerEl.innerHTML = `<div class="container" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:4px 10px 10px;box-sizing:border-box;"><div class="initializing">Initializing agent...</div></div>`
      this._renderMode = 'initializing'
      return
    }

    if (this._renderMode !== 'chat') {
      this.buildChatLayout()
      this._renderMode = 'chat'
    }
    this.updateAll()
  }

  private clearChatRefs() {
    this.messagesEl = null
    this._errorBanner = null
    this._retryBanner = null
    if (this._retryCountdownTimer) { clearInterval(this._retryCountdownTimer); this._retryCountdownTimer = null }
    this.clearPhaseLabelTimer()
    this._currentPhase = null
    this._notifyBtn = null
    this._settingsBtn = null
    this._stopBtn = null
    this._statusEl = null
    this._statusProviderEl = null
    this._statusStatsEl = null
    this._providerGridEl = null
    this._sessionTabsEl = null
    this._chatInputEl = null
    this._scrollToBottomBtn = null
    this._traceBtn = null
    this._tracePanelEl = null
    this._toolPopupEl = null
    this._toolPopupDescription = null
    this._toolPopupPills = null
    this._toolPopupBody = null
    this._inlineSlot = 'messages'
    this._activeToolId = null
    this._activeToolSig = null
  }

  private buildChatLayout() {
    this.clearChatRefs()
    this.containerEl.innerHTML = ''

    const container = document.createElement('div')
    container.className = 'container'
    container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:4px 10px 10px;box-sizing:border-box;'

    // Provider grid (sub-component, shown when no messages)
    this._providerGridEl = document.createElement('awfy-provider-grid')
    this._providerGridEl.style.display = 'none'
    this._providerGridEl.addEventListener('provider-error', (e: Event) => {
      this.error = (e as CustomEvent).detail.message
      this.updateErrorBanner()
    })
    container.appendChild(this._providerGridEl)

    // Messages area
    this.messagesEl = document.createElement('div')
    this.messagesEl.className = 'messages'
    this.messagesEl.style.cssText = 'flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;margin:0 -10px;padding:0 10px;'
    this.messagesEl.addEventListener('scroll', this.handleMessagesScroll)
    this.messagesEl.addEventListener('wheel', this.handleUserScrollIntent, { passive: true })
    this.messagesEl.addEventListener('keydown', this.handleScrollKeydown)
    this.messagesEl.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement

      // Tool header → open details popup
      const toolHeader = target.closest('.tool-header[data-tool-id]') as HTMLElement | null
      if (toolHeader) {
        e.preventDefault()
        const toolId = toolHeader.dataset.toolId
        if (toolId) this.openToolPopup(toolId)
      }
    })
    this.messagesEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement

      if (target.tagName === 'IMG') {
        const img = target as HTMLImageElement
        if (img.matches('.user-file-image') || img.closest('.tp-img-wrap')) {
          e.preventDefault()
          this.openImageLightbox(img.src)
          return
        }
      }

      const anchor = target.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      e.preventDefault()
      const href = anchor.getAttribute('href')
      if (!href) return

      const tabRequest = parseTabLink(href)
      if (tabRequest) {
        window.ipc?.tabs.openTab(tabRequest)
      } else if (href.startsWith('http://') || href.startsWith('https://')) {
        window.ipc?.dialog.openExternal(href)
      }
    })
    // Scroll-to-bottom button
    this._scrollToBottomBtn = document.createElement('div')
    this._scrollToBottomBtn.className = 'scroll-to-bottom'
    this._scrollToBottomBtn.innerHTML = '<svg viewBox="0 0 12 12"><path d="M6 9L1.5 4.5 2.56 3.44 6 6.88 9.44 3.44 10.5 4.5z"/></svg> New messages'
    this._scrollToBottomBtn.addEventListener('click', () => {
      this.userScrolledUp = false
      this.updateScrollToBottomBtn()
      this.scrollToBottom()
    })
    this.messagesEl.appendChild(this._scrollToBottomBtn)

    container.appendChild(this.messagesEl)

    // Inline panels share the messages flex slot — DOM order matters for the
    // visual position when one of them takes over from messagesEl.
    this.buildToolPopup(container)
    this._tracePanelEl = document.createElement('awfy-trace-panel') as TlTracePanel
    this._tracePanelEl.addEventListener('open', () => this.setInlineSlot('trace'))
    this._tracePanelEl.addEventListener('close', () => {
      if (this._inlineSlot === 'trace') this.setInlineSlot('messages')
    })
    container.appendChild(this._tracePanelEl)

    // Error banner
    this._errorBanner = document.createElement('div')
    this._errorBanner.className = 'error-banner'
    this._errorBanner.style.display = 'none'
    container.appendChild(this._errorBanner)

    // Retry banner
    this._retryBanner = document.createElement('div')
    this._retryBanner.className = 'retry-banner'
    this._retryBanner.style.display = 'none'
    container.appendChild(this._retryBanner)

    const inputArea = document.createElement('div')
    inputArea.className = 'input-area'

    const composer = document.createElement('div')
    composer.className = 'composer'

    this._sessionTabsEl = document.createElement('awfy-session-tabs')
    this._sessionTabsEl.addEventListener('session-error', (e: Event) => {
      this.error = (e as CustomEvent).detail.message
      this.updateErrorBanner()
    })
    composer.appendChild(this._sessionTabsEl)

    this._chatInputEl = document.createElement('awfy-chat-input') as TlChatInput
    this._chatInputEl.addEventListener('chat-send', () => {
      this.userScrolledUp = false
      this.error = null
      this.updateScrollToBottomBtn()
      this.updateErrorBanner()
    })
    this._chatInputEl.addEventListener('chat-error', (e: Event) => {
      this.error = (e as CustomEvent).detail.message
      this.updateErrorBanner()
    })
    composer.appendChild(this._chatInputEl)

    const bar = document.createElement('div')
    bar.className = 'composer-bar'

    bar.appendChild(makeIconBtn('Attach image', ATTACH_SVG, () => this._chatInputEl?.triggerFileSelect()))
    this._notifyBtn = makeIconBtn(
      'Notify when finished',
      NOTIFY_SVG + '<span class="icon-badge"></span>',
      () => agentSessionStore.setNotifyOnFinish(!agentSessionStore.state.notifyOnFinish),
    )
    bar.appendChild(this._notifyBtn)
    bar.appendChild(makeIconBtn('All sessions', HISTORY_SVG, () => window.ipc?.commandPalette?.show({ screen: 'sessions' })))
    this._traceBtn = makeIconBtn('Function trace', TRACE_SVG, () => this.handleOpenTracePanel())
    this._traceBtn.style.display = 'none'
    bar.appendChild(this._traceBtn)
    this._settingsBtn = makeIconBtn('Settings', GEAR_SVG, () => this.openActiveProviderSettings())
    bar.appendChild(this._settingsBtn)

    const spacer = document.createElement('div')
    spacer.className = 'spacer'
    bar.appendChild(spacer)

    this._stopBtn = document.createElement('button')
    this._stopBtn.className = 'composer-stop'
    this._stopBtn.title = 'Stop generation'
    this._stopBtn.innerHTML = '<span class="composer-stop-sq"></span><span>Stop</span>'
    this._stopBtn.style.display = 'none'
    this._stopBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.handleStop()
    })
    bar.appendChild(this._stopBtn)

    composer.appendChild(bar)

    this._statusEl = document.createElement('div')
    this._statusEl.className = 'composer-status'
    this._statusProviderEl = document.createElement('span')
    this._statusProviderEl.className = 'provider-name'
    this._statusStatsEl = document.createElement('span')
    this._statusStatsEl.className = 'provider-stats'
    this._statusEl.append(this._statusProviderEl, this._statusStatsEl)
    composer.appendChild(this._statusEl)

    inputArea.appendChild(composer)

    container.appendChild(inputArea)

    this.containerEl.appendChild(container)
  }

  private handleOpenTracePanel() {
    const panel = this._tracePanelEl
    if (!panel) return
    if (panel.isOpen()) { panel.close(); return }
    const s = agentSessionStore.state
    const sessionId = s.activeSessionId
    if (!sessionId) {
      this.error = 'No active session to show traces for'
      this.updateErrorBanner()
      return
    }
    if (this._activeToolId) this.closeToolPopup()
    void panel.open(sessionId, s.label || '')
  }

  /** Owns visibility of messagesEl + the two inline panels. */
  private setInlineSlot(slot: 'messages' | 'trace' | 'tool') {
    if (this._inlineSlot === slot) return
    this._inlineSlot = slot
    const target = slot === 'messages' ? '' : 'none'
    if (this.messagesEl && this.messagesEl.style.display !== target) {
      this.messagesEl.style.display = target
    }
    if (this._toolPopupEl) this._toolPopupEl.hidden = slot !== 'tool'
    // Trace panel manages its own `hidden` via open()/close().
  }

  private buildToolPopup(container: HTMLElement) {
    const popup = document.createElement('div')
    popup.className = 'tool-popup'
    popup.hidden = true

    const header = document.createElement('div')
    header.className = 'tool-popup-header'

    const description = document.createElement('div')
    description.className = 'tool-popup-description'

    const pills = document.createElement('div')
    pills.className = 'tool-popup-pills'

    const closeBtn = document.createElement('button')
    closeBtn.className = 'tool-popup-close'
    closeBtn.type = 'button'
    closeBtn.title = 'Close'
    closeBtn.setAttribute('aria-label', 'Close tool details')
    closeBtn.innerHTML = CLOSE_ICON_SVG
    closeBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.closeToolPopup()
    })

    header.append(description, pills, closeBtn)

    const body = document.createElement('div')
    body.className = 'tool-popup-body'
    body.addEventListener('click', this.onToolPopupBodyClick)

    popup.append(header, body)
    container.appendChild(popup)

    this._toolPopupEl = popup
    this._toolPopupDescription = description
    this._toolPopupPills = pills
    this._toolPopupBody = body
  }

  private onToolPopupBodyClick = (e: Event) => {
    const target = e.target as HTMLElement
    const copyBtn = target.closest('.tp-copy[data-copy]') as HTMLButtonElement | null
    if (!copyBtn) return
    e.preventDefault()
    e.stopPropagation()
    const key = copyBtn.dataset.copy
    const tool = key ? this.findActiveTool() : null
    if (!tool || !key) return
    void copyToButton(copyBtn, resolveToolCopyText(tool, key))
  }

  private findActiveTool(): ToolPair | null {
    if (!this._activeToolId) return null
    const s = agentSessionStore.state
    if (s.streamingMessage) {
      const fromStream = findToolPair([s.streamingMessage], this._activeToolId)
      if (fromStream) return fromStream
    }
    return findToolPair(s.messages, this._activeToolId)
  }

  private toolSignature(tool: ToolPair): string {
    let n = 0
    if (Array.isArray(tool.result)) {
      for (const item of tool.result as Array<Record<string, unknown>>) {
        if (typeof item.text === 'string') n += item.text.length
        else if (typeof item.data === 'string') n += item.data.length
      }
    } else if (tool.result !== null) {
      n = 1
    }
    return `${tool.code.length}|${tool.isError ? 1 : 0}|${n}`
  }

  private openToolPopup(toolId: string) {
    if (this._tracePanelEl?.isOpen()) this._tracePanelEl.close()
    this._activeToolId = toolId
    const tool = this.findActiveTool()
    if (!tool) { this._activeToolId = null; return }
    this.renderToolPopup(tool, true)
    this.setInlineSlot('tool')
  }

  private renderToolPopup(tool: ToolPair, resetScroll: boolean) {
    if (!this._toolPopupDescription || !this._toolPopupPills || !this._toolPopupBody) return
    // Parse once, share with both renderers — avoids re-parsing the result blob per paint.
    const parsed = parseToolResult(tool.result)
    this._toolPopupDescription.textContent = tool.description
    this._toolPopupDescription.title = tool.description
    this._toolPopupPills.innerHTML = renderToolStatusPillHtml(tool, parsed)
    this._toolPopupBody.innerHTML = renderToolDetailsHtml(tool, parsed)
    if (resetScroll) this._toolPopupBody.scrollTop = 0
    this._activeToolSig = this.toolSignature(tool)
  }

  private refreshToolPopup() {
    if (!this._activeToolId) return
    const tool = this.findActiveTool()
    if (!tool) return
    const sig = this.toolSignature(tool)
    if (sig === this._activeToolSig) return
    this.renderToolPopup(tool, false)
  }

  private closeToolPopup() {
    if (this._toolPopupBody) this._toolPopupBody.innerHTML = ''
    this._activeToolId = null
    this._activeToolSig = null
    this.setInlineSlot('messages')
  }

  private onPopupKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._activeToolId) {
      e.preventDefault()
      e.stopPropagation()
      this.closeToolPopup()
    }
  }

  private async handleStop() {
    try {
      await agentSessionStore.abort()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.updateErrorBanner()
    }
  }

  // ── Targeted update methods ──

  /** Full UI sync — called on initial render and mode switch. */
  private updateAll() {
    this.updateMessages()
    this.updateProviderGridVisibility()
    this.updateErrorBanner()
    this.updateRetryBanner()
    this.updateNotifyBtn()
    this.updateStopBtn()
    this.updateTraceBtn()
    this.updateStatus()
  }

  /** Update the messages area only (hot path during streaming). */
  private updateMessages() {
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming
    const inlineActive = this._inlineSlot !== 'messages'
    const target = (hasMessages && !inlineActive) ? '' : 'none'

    if (this.messagesEl && this.messagesEl.style.display !== target) {
      this.messagesEl.style.display = target
    }

    if (!this.messagesEl || !hasMessages) return

    const allMessages = s.isStreaming && s.streamingMessage
      ? [...s.messages, s.streamingMessage]
      : s.messages
    const displayBlocks = buildRenderBlocks(allMessages)

    const prevChildCount = this.messagesEl.childElementCount
    const wasScrolledUp = this.userScrolledUp
    const pendingTarget = this._pendingScrollTarget
    this._pendingScrollTarget = null
    const prevScrollTop = pendingTarget !== null
      ? pendingTarget
      : (wasScrolledUp ? this.messagesEl.scrollTop : 0)
    updateMessagesEl(this.messagesEl, displayBlocks, s.isStreaming)
    this.updatePhaseLabel(s)
    this.refreshToolPopup()

    if (this._scrollToBottomBtn && this.messagesEl.childElementCount !== prevChildCount) {
      this.messagesEl.appendChild(this._scrollToBottomBtn)
    }

    if (!this.userScrolledUp) {
      const gap = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight
      if (gap > TlAgentChat.SCROLL_THRESHOLD) {
        this.scrollToBottom()
      }
    } else if (pendingTarget !== null || this.messagesEl.scrollTop !== prevScrollTop) {
      this._programmaticScrollCount++
      this.messagesEl.scrollTop = prevScrollTop
      requestAnimationFrame(() => { this._programmaticScrollCount-- })
    }
    this.updateScrollToBottomBtn()
  }

  private updateProviderGridVisibility() {
    if (!this._providerGridEl) return
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming
    if (hasMessages) {
      this._providerGridEl.style.display = 'none'
    } else {
      this._providerGridEl.style.display = ''
      this._providerGridEl.style.justifyContent = 'center'
      this._providerGridEl.style.flex = '1'
    }
  }

  private updateErrorBanner() {
    if (!this._errorBanner) return
    if (this.error) {
      this._errorBanner.style.display = ''
      this._errorBanner.textContent = this.error
    } else {
      this._errorBanner.style.display = 'none'
    }
  }

  private updateNotifyBtn() {
    if (!this._notifyBtn) return
    const s = agentSessionStore.state
    this._notifyBtn.classList.toggle('active', s.notifyOnFinish)
  }

  private updateStopBtn() {
    if (!this._stopBtn) return
    const s = agentSessionStore.state
    this._stopBtn.style.display = s.isStreaming ? '' : 'none'
  }

  private updateTraceBtn() {
    if (!this._traceBtn) return
    const s = agentSessionStore.state
    this._traceBtn.style.display = s.activeSessionId ? '' : 'none'
  }

  private updateStatus() {
    if (!this._statusEl || !this._statusProviderEl || !this._statusStatsEl) return
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming
    const providerId = hasMessages ? s.providerId : s.selectedProviderId
    const provider = s.providerList.find(p => p.id === providerId)
    const providerName = provider?.name || providerId || ''
    const statusLine = hasMessages
      ? (s.statusLine || s.configStatusLine)
      : (s.providerStatusLines.get(providerId) || '')
    const stats = statusLine ? (providerName ? ' · ' + statusLine : statusLine) : ''

    if (this._statusProviderEl.textContent !== providerName) this._statusProviderEl.textContent = providerName
    if (this._statusStatsEl.textContent !== stats) this._statusStatsEl.textContent = stats
    const title = providerName && statusLine ? providerName + ' · ' + statusLine : (providerName || statusLine)
    if (this._statusEl.title !== title) this._statusEl.title = title
  }

  // ── Provider actions ──

  private openActiveProviderSettings() {
    const s = agentSessionStore.state
    const providerId = s.messages.length > 0 ? s.providerId : s.selectedProviderId
    const provider = s.providerList.find(p => p.id === providerId)
    if (provider?.settingsView) {
      this.openProviderSettingsView(provider.settingsView)
    }
  }

  private async openProviderSettingsView(viewName: string) {
    try {
      await window.ipc?.tabs.openTab({ viewName })
    } catch (e) {
      console.error('[agent-chat] failed to open provider settings view', e)
    }
  }
}
