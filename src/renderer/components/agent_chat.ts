import {
  buildRenderBlocks,
  updateMessagesEl
} from './chat_message_renderer.js'
import { escapeHtml, parseTabLink } from './chat_utils.js'
import { agentSessionStore } from '../stores/agent-session-store.js'

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
  /* ── Tool card ── */
  .tool-card {
    background: var(--color-bg2);
    border-radius: var(--radius-md);
    margin: 4px -10px;
    padding: 0;
    overflow: hidden;
  }
  .tool-header {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 1px 0;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    color: var(--color-text2);
  }
  .tool-card .tool-header {
    padding: 6px 10px;
  }
  .tool-header:hover { color: var(--color-text3); }
  .tool-description {
    flex: 1;
    min-width: 0;
  }
  .tool-error-badge {
    font-size: 10px;
    color: var(--color-red-fg);
    flex-shrink: 0;
  }
  .tb-tabs {
    display: flex;
    gap: 0;
    padding: 0 10px;
    border-bottom: 1px solid var(--color-border);
  }
  .tb-tab {
    padding: 4px 10px 5px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--color-text2);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color var(--transition-fast);
    user-select: none;
  }
  .tb-tab:hover { color: var(--color-text3); }
  .tb-tab.active {
    color: var(--color-text4);
    border-bottom-color: var(--color-accent);
  }
  .tb-tab.tab-error {
    color: var(--color-red-fg);
  }
  .tb-tab.tab-error.active {
    border-bottom-color: var(--color-red-fg);
  }
  .tb-badge {
    display: inline-block;
    background: var(--color-accent);
    color: #fff;
    font-size: 8px;
    padding: 0 4px;
    border-radius: 6px;
    margin-left: 3px;
    line-height: 14px;
    vertical-align: middle;
  }
  .tool-body {
    font-size: 11px;
  }
  .tb-pane {
    display: none;
    padding: 8px 10px;
  }
  .tb-pane.active {
    display: block;
  }
  .tool-body pre {
    margin: 0;
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: auto;
    background: var(--color-bg3);
    border-radius: var(--radius-sm);
    color: var(--color-text3);
  }
  .tool-body pre.tool-result-empty {
    color: var(--color-text2);
    font-style: italic;
  }
  .result-section { margin-bottom: 6px; }
  .result-section:last-child { margin-bottom: 0; }
  .rs-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--color-text2);
    margin-bottom: 3px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .rs-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-value { background: var(--color-green-fg); }
  .dot-log { background: var(--color-accent); }
  .dot-error { background: var(--color-red-fg); }
  .rs-meta {
    font-weight: 400;
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .log-list {
    background: var(--color-bg3);
    border-radius: var(--radius-sm);
    padding: 4px 0;
    max-height: 120px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
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
  .error-block {
    padding: 6px 8px;
    background: var(--color-red-bg);
    color: var(--color-red-fg);
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-family: var(--font-mono);
    line-height: 1.45;
  }
  .error-name { font-weight: 700; margin-bottom: 2px; }
  .error-msg { word-break: break-word; }
  .tb-img-wrap {
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--color-border);
  }
  .tb-img-wrap + .tb-img-wrap { margin-top: 6px; }
  .tb-img-wrap img {
    display: block;
    max-width: 100%;
  }
  .awfy-app-root.zen-mode .tb-img-wrap img {
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
  .tb-img-meta {
    padding: 4px 8px;
    font-size: 10px;
    color: var(--color-text2);
    background: var(--color-bg3);
    border-top: 1px solid var(--color-border);
    display: flex;
    gap: 6px;
  }
  .tb-img-meta .pill {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    background: var(--color-bg1);
    color: var(--color-text2);
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
  .tools-row {
    margin-top: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
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
  .tools-row-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .popup-panel {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--color-bg2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    max-height: 300px;
    overflow-y: auto;
    box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
    margin-bottom: 4px;
    z-index: 10;
  }
  .provider-panel {
    padding: 4px 0;
  }
  .gear-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    color: var(--color-text2);
    font-size: 16px;
    line-height: 1;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .gear-btn:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .gear-btn.active { color: var(--color-accent); }
  .gear-btn.active svg { fill: currentColor; }
  .provider-panel-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 12px;
    color: var(--color-text3);
  }
  .provider-panel-item:hover { background: var(--color-item-hover); }
  .provider-panel-item.active {
    background: var(--color-item-hover);
    font-weight: 600;
  }
  .provider-active-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4caf50;
    flex-shrink: 0;
  }
  .provider-active-dot.hidden { visibility: hidden; }
  .provider-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .provider-settings-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    color: var(--color-text2);
    font-size: 14px;
    line-height: 1;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .provider-settings-btn:hover {
    color: var(--color-text4);
    background: var(--color-item-hover);
  }
  .provider-info {
    font-size: 11px;
    color: var(--color-text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .provider-info-name {
    font-weight: 600;
    color: var(--color-text3);
  }
`

export class TlAgentChat extends HTMLElement {
  private _unsubs: (() => void)[] = []
  private error: string | null = null
  private activePanel: 'providers' | null = null
  private isInitializing = true
  private messagesEl: HTMLElement | null = null
  private openToolSet = new Set<string>()
  private activeTabs = new Map<string, string>()
  private containerEl!: HTMLDivElement
  private styleEl!: HTMLStyleElement
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
  private _newSessionBtn: HTMLElement | null = null
  private _notifyBtn: HTMLElement | null = null
  private _settingsBtn: HTMLElement | null = null
  private _providerPanel: HTMLElement | null = null
  private _providerInfo: HTMLElement | null = null
  private _providerGridEl: HTMLElement | null = null
  private _sessionTabsEl: HTMLElement | null = null
  private _chatInputEl: HTMLElement | null = null
  private _closeLightbox: (() => void) | null = null
  private _isZenMode = false
  private _unlistenZenMode: (() => void) | null = null

  // Per-agent state cache (scroll & tool state only — input state is in chat-input)
  private _chatStateCache = new Map<string, { userScrolledUp: boolean; openToolSet: Set<string>; activeTabs: Map<string, string> }>()
  private _currentAgentRoot: string | null = null

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
    this._closeLightbox?.()
    for (const unsub of this._unsubs) unsub()
    this._unsubs.length = 0
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
        openToolSet: new Set(this.openToolSet),
        activeTabs: new Map(this.activeTabs),
      })
    }

    const cached = newAgentRoot ? this._chatStateCache.get(newAgentRoot) : null
    if (cached) {
      this.userScrolledUp = cached.userScrolledUp
      this.openToolSet = new Set(cached.openToolSet)
      this.activeTabs = new Map(cached.activeTabs)
    } else {
      this.userScrolledUp = false
      this.openToolSet.clear()
      this.activeTabs.clear()
    }

    if (agents) {
      const activePaths = new Set(agents.map(a => a.path))
      for (const key of this._chatStateCache.keys()) {
        if (!activePaths.has(key)) this._chatStateCache.delete(key)
      }
    }

    this.activePanel = null
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

    if (!window.ipc?.agent) {
      this.activePanel = 'providers'
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

  private subscribeToStore() {
    // Streaming message deltas (hot path) — only update messages area
    this._unsubs.push(agentSessionStore.select(
      s => s.streamingMessage,
      () => this.updateMessages()
    ))

    // Messages array changed (new messages, session loaded)
    this._unsubs.push(agentSessionStore.select(
      s => s.messages,
      () => {
        this.error = null
        this.updateMessages()
        this.updateProviderGridVisibility()
        this.updateNewSessionBtn()
      }
    ))

    // Streaming state toggled (start/stop)
    this._unsubs.push(agentSessionStore.select(
      s => s.isStreaming,
      () => {
        this.error = null
        this.updateMessages()
        this.updateProviderGridVisibility()
        this.updateNewSessionBtn()
        this.updateNotifyBtn()
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
      () => this.updateProviderInfo()
    ))

    // Provider list (for popup panel)
    this._unsubs.push(agentSessionStore.select(
      s => s.providerList,
      () => this.updateProviderPanel()
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

  private async handleNewSession() {
    this.activePanel = null
    try {
      await agentSessionStore.createSession()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
    this.updateErrorBanner()
  }

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
    this._newSessionBtn = null
    this._notifyBtn = null
    this._settingsBtn = null
    this._providerPanel = null
    this._providerInfo = null
    this._providerGridEl = null
    this._sessionTabsEl = null
    this._chatInputEl = null
    this._scrollToBottomBtn = null
  }

  private buildChatLayout() {
    this.clearChatRefs()
    this.containerEl.innerHTML = ''

    const container = document.createElement('div')
    container.className = 'container'
    container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden;padding:4px 10px 10px;box-sizing:border-box;'

    // Session tabs (sub-component)
    this._sessionTabsEl = document.createElement('awfy-session-tabs')
    this._sessionTabsEl.addEventListener('session-error', (e: Event) => {
      this.error = (e as CustomEvent).detail.message
      this.updateErrorBanner()
    })
    container.appendChild(this._sessionTabsEl)

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
    this.messagesEl.style.cssText = 'flex:1;min-height:0;overflow-y:auto;'
    this.messagesEl.addEventListener('scroll', this.handleMessagesScroll)
    this.messagesEl.addEventListener('wheel', this.handleUserScrollIntent, { passive: true })
    this.messagesEl.addEventListener('keydown', this.handleScrollKeydown)
    this.messagesEl.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement

      // Tab switching within tool cards
      const tab = target.closest('.tb-tab[data-tool-tab]') as HTMLElement | null
      if (tab) {
        e.preventDefault()
        const toolId = tab.dataset.toolTab!
        const pane = tab.dataset.pane!
        this.activeTabs.set(toolId, pane)
        const card = tab.closest('.tool-card') as HTMLElement | null
        if (card) {
          card.querySelectorAll<HTMLElement>(`.tb-tab[data-tool-tab="${toolId}"]`).forEach(t => t.classList.remove('active'))
          card.querySelectorAll<HTMLElement>(`.tb-pane[data-tool-pane="${toolId}"]`).forEach(p => p.classList.remove('active'))
          tab.classList.add('active')
          const targetPane = card.querySelector<HTMLElement>(`.tb-pane[data-tool-pane="${toolId}"][data-pane="${pane}"]`)
          if (targetPane) targetPane.classList.add('active')
        }
        return
      }

      // Tool header collapse/expand toggle
      const toolHeader = target.closest('.tool-header[data-tool-id]') as HTMLElement | null
      if (toolHeader) {
        e.preventDefault()
        const toolId = toolHeader.dataset.toolId
        if (toolId) {
          if (this.openToolSet.has(toolId)) {
            this.openToolSet.delete(toolId)
          } else {
            this.openToolSet.add(toolId)
          }
          this.updateMessages()
        }
      }
    })
    this.messagesEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement

      if (target.tagName === 'IMG') {
        const img = target as HTMLImageElement
        if (img.matches('.user-file-image') || img.closest('.tb-img-wrap')) {
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

    // Input area
    const inputArea = document.createElement('div')
    inputArea.className = 'input-area'

    // Provider panel popup (hidden by default)
    this._providerPanel = document.createElement('div')
    this._providerPanel.className = 'popup-panel provider-panel'
    this._providerPanel.style.display = 'none'
    this._providerPanel.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement
      const settingsBtn = target.closest('.provider-settings-btn[data-provider-idx]') as HTMLElement | null
      if (settingsBtn) {
        e.preventDefault()
        e.stopPropagation()
        const idx = parseInt(settingsBtn.dataset.providerIdx!, 10)
        const provider = agentSessionStore.state.providerList[idx]
        if (provider?.settingsView) {
          this.activePanel = null
          this.updateProviderPanel()
          this.openProviderSettingsView(provider.settingsView)
        }
        return
      }
      const providerItem = target.closest('.provider-panel-item[data-provider-idx]') as HTMLElement | null
      if (providerItem) {
        e.preventDefault()
        const idx = parseInt(providerItem.dataset.providerIdx!, 10)
        const provider = agentSessionStore.state.providerList[idx]
        if (provider && provider.id !== agentSessionStore.state.providerId) {
          this.handleSelectProvider(provider.id)
        }
      }
    })
    inputArea.appendChild(this._providerPanel)

    // Chat input (sub-component)
    this._chatInputEl = document.createElement('awfy-chat-input')
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
    inputArea.appendChild(this._chatInputEl)

    // Tools row
    const toolsRow = document.createElement('div')
    toolsRow.className = 'tools-row'

    this._providerInfo = document.createElement('div')
    this._providerInfo.className = 'provider-info'
    toolsRow.appendChild(this._providerInfo)

    const actionsDiv = document.createElement('div')
    actionsDiv.className = 'tools-row-actions'

    // New session button
    this._newSessionBtn = document.createElement('button')
    this._newSessionBtn.className = 'gear-btn'
    this._newSessionBtn.title = 'New session'
    this._newSessionBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>'
    this._newSessionBtn.style.display = 'none'
    this._newSessionBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.handleNewSession()
    })
    actionsDiv.appendChild(this._newSessionBtn)

    // Attach button (triggers file select in chat-input)
    const attachBtn = document.createElement('button')
    attachBtn.className = 'gear-btn'
    attachBtn.title = 'Attach image'
    attachBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6.5 7.5 12a3 3 0 0 1-4.24-4.24l6-6a2 2 0 1 1 2.83 2.83l-6 6a1 1 0 0 1-1.42-1.42L9.5 4.5"/></svg>'
    attachBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      ;(this._chatInputEl as any)?.triggerFileSelect?.()
    })
    actionsDiv.appendChild(attachBtn)

    // Notify button
    this._notifyBtn = document.createElement('button')
    this._notifyBtn.className = 'gear-btn'
    this._notifyBtn.title = 'Notify when finished'
    this._notifyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5C5.5 1.5 4 3.5 4 5.5c0 3-1.5 4.5-2 5h12c-.5-.5-2-2-2-5 0-2-1.5-4-4-4z"/><path d="M6.5 12.5c.3.6.9 1 1.5 1s1.2-.4 1.5-1"/></svg>'
    this._notifyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      agentSessionStore.setNotifyOnFinish(!agentSessionStore.state.notifyOnFinish)
    })
    actionsDiv.appendChild(this._notifyBtn)

    // Sessions button
    const sessionsBtn = document.createElement('button')
    sessionsBtn.className = 'gear-btn'
    sessionsBtn.title = 'All sessions'
    sessionsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8a6.5 6.5 0 1 1 1.1 3.6"/><polyline points="1 5 1.5 8 4.5 8"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>'
    sessionsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      window.ipc?.commandPalette?.show({ screen: 'sessions' })
    })
    actionsDiv.appendChild(sessionsBtn)

    // Settings button
    this._settingsBtn = document.createElement('button')
    this._settingsBtn.className = 'gear-btn'
    this._settingsBtn.title = 'Settings'
    this._settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    this._settingsBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.openActiveProviderSettings()
    })
    actionsDiv.appendChild(this._settingsBtn)

    toolsRow.appendChild(actionsDiv)
    inputArea.appendChild(toolsRow)

    container.appendChild(inputArea)
    this.containerEl.appendChild(container)
  }

  // ── Targeted update methods ──

  /** Full UI sync — called on initial render and mode switch. */
  private updateAll() {
    this.updateMessages()
    this.updateProviderGridVisibility()
    this.updateErrorBanner()
    this.updateRetryBanner()
    this.updateNotifyBtn()
    this.updateNewSessionBtn()
    this.updateProviderInfo()
    this.updateProviderPanel()
  }

  /** Update the messages area only (hot path during streaming). */
  private updateMessages() {
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming

    if (this.messagesEl) {
      this.messagesEl.style.display = hasMessages ? '' : 'none'
    }

    if (!this.messagesEl || !hasMessages) return

    const allMessages = s.isStreaming && s.streamingMessage
      ? [...s.messages, s.streamingMessage]
      : s.messages
    const displayBlocks = buildRenderBlocks(allMessages)

    const prevChildCount = this.messagesEl.childElementCount
    const wasScrolledUp = this.userScrolledUp
    const prevScrollTop = wasScrolledUp ? this.messagesEl.scrollTop : 0
    updateMessagesEl(this.messagesEl, displayBlocks, this.openToolSet, this.activeTabs, s.isStreaming)
    this.updatePhaseLabel(s)

    if (this._scrollToBottomBtn && this.messagesEl.childElementCount !== prevChildCount) {
      this.messagesEl.appendChild(this._scrollToBottomBtn)
    }

    if (!this.userScrolledUp) {
      const gap = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight
      if (gap > TlAgentChat.SCROLL_THRESHOLD) {
        this.scrollToBottom()
      }
    } else if (this.messagesEl.scrollTop !== prevScrollTop) {
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
    const hasMessages = s.messages.length > 0 || s.isStreaming
    this._notifyBtn.style.display = hasMessages ? '' : 'none'
    this._notifyBtn.classList.toggle('active', s.notifyOnFinish)
  }

  private updateNewSessionBtn() {
    if (!this._newSessionBtn) return
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming
    this._newSessionBtn.style.display = hasMessages ? '' : 'none'
  }

  private updateProviderInfo() {
    if (!this._providerInfo) return
    const s = agentSessionStore.state
    const hasMessages = s.messages.length > 0 || s.isStreaming
    const providerId = hasMessages ? s.providerId : s.selectedProviderId
    const provider = s.providerList.find(p => p.id === providerId)
    const providerName = provider?.name || providerId || ''
    const statusLine = hasMessages
      ? (s.statusLine || s.configStatusLine)
      : (s.providerStatusLines.get(providerId) || '')
    const sep = providerName && statusLine ? ' · ' : ''
    this._providerInfo.innerHTML = providerName
      ? `<span class="provider-info-name">${escapeHtml(providerName)}</span>${sep}${escapeHtml(statusLine)}`
      : escapeHtml(statusLine)
  }

  private updateProviderPanel() {
    if (!this._providerPanel) return
    if (this.activePanel === 'providers') {
      this._providerPanel.style.display = ''
      this._providerPanel.innerHTML = this.renderProviderPanelHtml()
    } else {
      this._providerPanel.style.display = 'none'
    }
  }

  // ── Provider actions ──

  private async handleSelectProvider(providerId: string) {
    try {
      this.activePanel = null
      await agentSessionStore.switchProvider(providerId)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.updateErrorBanner()
    }
  }

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

  private renderProviderPanelHtml(): string {
    const s = agentSessionStore.state
    if (s.providerList.length === 0) {
      return '<div style="padding:10px;font-size:12px;color:var(--color-text2)">No providers available</div>'
    }
    return s.providerList.map((p, i) => {
      const isActive = p.id === s.providerId
      const dotClass = isActive ? 'provider-active-dot' : 'provider-active-dot hidden'
      const itemClass = isActive ? 'provider-panel-item active' : 'provider-panel-item'
      const settingsBtn = p.settingsView
        ? `<button class="provider-settings-btn" data-provider-idx="${i}" title="Settings">&#9881;</button>`
        : ''
      return `<div class="${itemClass}" data-provider-idx="${i}">
        <span class="${dotClass}"></span>
        <span class="provider-name">${escapeHtml(p.name)}</span>
        ${settingsBtn}
      </div>`
    }).join('')
  }
}
