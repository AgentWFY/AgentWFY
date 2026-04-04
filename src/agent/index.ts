import type {
  AgentEvent,
  AgentState,
  FileContent,
  TextContent,
} from './types.js'
import type {
  ProviderSession,
  DisplayMessage,
  Block,
  ToolResult,
  ToolCall,
  ErrorCategory,
} from './provider_types.js'
import { truncateHead, TOOL_RESULT_MAX_CHARS } from './truncate.js'

// ── Constants ──

const MAX_RETRY_ATTEMPTS = 10
const RETRY_DELAYS = [5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 180_000, 240_000, 300_000, 300_000]
const RETRYABLE_CATEGORIES = new Set<ErrorCategory>(['network', 'rate_limit', 'server'])
const WATCHDOG_TIMEOUT_MS = 90_000
const WATCHDOG_CHECK_INTERVAL_MS = 5_000

interface AgentOptions {
  initialState?: Partial<AgentState>
  providerSession: ProviderSession
  sessionId?: string
}

export class Agent {
  private _state: AgentState = {
    systemPrompt: '',
    tools: [],
    messages: [],
    isStreaming: false,
    streamingMessage: null,
    error: undefined,
  }

  private listeners = new Set<(e: AgentEvent) => void>()
  providerSession: ProviderSession
  private followUpQueue: string[] = []
  private runningPrompt?: Promise<void>
  private resolveRunningPrompt?: () => void
  private retryAbortController: AbortController | null = null
  private toolAbortController: AbortController | null = null

  sessionId?: string

  constructor(opts: AgentOptions) {
    if (opts.initialState) {
      Object.assign(this._state, opts.initialState)
    }
    this.providerSession = opts.providerSession
    this.sessionId = opts.sessionId
  }

  get state(): AgentState {
    return this._state
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setProviderSession(session: ProviderSession): void {
    this.providerSession = session
  }

  getProviderTitle(): string {
    if (this.providerSession.getTitle) {
      return this.providerSession.getTitle()
    }
    for (const msg of this._state.messages) {
      if (msg.role !== 'user') continue
      const block = msg.blocks.find(b => b.type === 'text')
      if (block && block.type === 'text' && block.text.trim()) {
        return block.text.trim().slice(0, 100)
      }
    }
    return ''
  }

  getProviderState(): unknown {
    return this.providerSession.getState()
  }

  replaceMessages(ms: DisplayMessage[]): void {
    this._state.messages = ms.slice()
  }

  clearMessages(): void {
    this._state.messages = []
  }

  followUp(text: string): void {
    if (!text || !text.trim()) return
    this.followUpQueue.push(text)
  }

  abort(): void {
    this.followUpQueue = []
    this.retryAbortController?.abort()
    this.toolAbortController?.abort()
    this.providerSession.abort()
  }

  /** Skip the retry delay and retry immediately. */
  skipRetryDelay(): void {
    this.retryAbortController?.abort()
  }

  waitForIdle(): Promise<void> {
    return this.runningPrompt ?? Promise.resolve()
  }

  reset(): void {
    this._state.messages = []
    this._state.isStreaming = false
    this._state.streamingMessage = null
    this._state.error = undefined
    this._state.statusLine = undefined
    this._state.retryState = null
    this._state.stalledSince = null
    this.followUpQueue = []
  }

  async prompt(text: string, files?: FileContent[]): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing a prompt.')
    }
    await this.runLoop(text, files)
  }

  private async runLoop(text: string, files?: FileContent[]): Promise<void> {
    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve
    })
    this._state.isStreaming = true
    this._state.streamingMessage = null
    this._state.error = undefined
    this._state.retryState = null
    this._state.stalledSince = null

    const session = this.providerSession

    // Tool execution counter (supports parallel tool calls)
    let toolExecutionCount = 0
    let lastEventTime = Date.now()

    this.toolAbortController = new AbortController()
    const toolSignal = this.toolAbortController.signal

    const executeTool = async (call: ToolCall): Promise<ToolResult> => {
      const tool = this._state.tools.find(t => t.name === 'execJs')
      if (!tool) {
        return { content: [{ type: 'text', text: 'execJs tool not available' }], isError: true }
      }

      toolExecutionCount++
      try {
        const result = await tool.execute(call.id, {
          code: call.code,
          description: call.description,
          ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
        }, toolSignal)
        const contextContent = result.content.map(c => {
          if (c.type === 'text' && c.text.length > TOOL_RESULT_MAX_CHARS) {
            return { ...c, text: truncateHead(c.text) }
          }
          return c
        }) as (TextContent | FileContent)[]

        // Insert result right after its matching exec_js block to preserve order
        const resultBlock: Block = { type: 'exec_js_result', id: call.id, content: contextContent, isError: false }
        const callIdx = streamingBlocks.findIndex(b => b.type === 'exec_js' && b.id === call.id)
        if (callIdx !== -1) {
          streamingBlocks.splice(callIdx + 1, 0, resultBlock)
        } else {
          streamingBlocks.push(resultBlock)
        }
        this.emit({ type: 'stream_update' })

        return { content: contextContent, isError: false }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err)
        const resultBlock: Block = { type: 'exec_js_result', id: call.id, content: [{ type: 'text', text: errorText }], isError: true }
        const callIdx = streamingBlocks.findIndex(b => b.type === 'exec_js' && b.id === call.id)
        if (callIdx !== -1) {
          streamingBlocks.splice(callIdx + 1, 0, resultBlock)
        } else {
          streamingBlocks.push(resultBlock)
        }
        this.emit({ type: 'stream_update' })
        return { content: [{ type: 'text', text: errorText }], isError: true }
      } finally {
        toolExecutionCount--
      }
    }

    let streamingBlocks: Block[] = []

    try {
      this.emit({ type: 'agent_start' })

      let currentText = text
      let currentFiles = files

      while (true) {
        // Add user message to local display
        const userBlocks: Block[] = [{ type: 'text', text: currentText }]
        if (currentFiles) {
          for (const f of currentFiles) {
            userBlocks.push({ type: 'file', mimeType: f.mimeType, data: f.data })
          }
        }
        this._state.messages = [...this._state.messages, { role: 'user', blocks: userBlocks, timestamp: Date.now() }]

        // Retry loop
        for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
          // Watchdog: check elapsed time via interval instead of resetting timers per event
          lastEventTime = Date.now()
          const watchdog = setInterval(() => {
            if (toolExecutionCount === 0 && Date.now() - lastEventTime > WATCHDOG_TIMEOUT_MS) {
              this._state.stalledSince ??= Date.now()
              this.emit({ type: 'stalled', elapsedMs: Date.now() - lastEventTime })
            }
          }, WATCHDOG_CHECK_INTERVAL_MS)

          try {
            const iterable = attempt === 0
              ? session.stream({ text: currentText, files: currentFiles }, executeTool)
              : session.retry(executeTool)

            streamingBlocks = []
            this._state.streamingMessage = { role: 'assistant', blocks: streamingBlocks, timestamp: Date.now() }

            // Clear retry state silently on first event (will be picked up by next snapshot)
            let retryCleared = !this._state.retryState

            for await (const event of iterable) {
              lastEventTime = Date.now()
              this._state.stalledSince = null
              if (!retryCleared) {
                this._state.retryState = null
                retryCleared = true
              }

              switch (event.type) {
                case 'text_delta': {
                  const last = streamingBlocks[streamingBlocks.length - 1]
                  if (last && last.type === 'text') {
                    last.text += event.delta
                  } else {
                    streamingBlocks.push({ type: 'text', text: event.delta })
                  }
                  this.emit({ type: 'stream_update' })
                  break
                }

                case 'thinking_delta': {
                  const last = streamingBlocks[streamingBlocks.length - 1]
                  if (last && last.type === 'thinking') {
                    last.text += event.delta
                  } else {
                    streamingBlocks.push({ type: 'thinking', text: event.delta })
                  }
                  this.emit({ type: 'stream_update' })
                  break
                }

                case 'exec_js': {
                  streamingBlocks.push({ type: 'exec_js', id: event.id, description: event.description, code: event.code })
                  this.emit({ type: 'stream_update' })
                  break
                }

                case 'status_line':
                  this._state.statusLine = event.text
                  this.emit({ type: 'status_line', text: event.text })
                  break

                case 'state_changed':
                  this.emit({ type: 'state_changed' })
                  break
              }
            }

            // Iterator completed — stream succeeded
            clearInterval(watchdog)
            this._state.streamingMessage = null

            // Provider is the source of truth for committed display messages
            this._state.messages = session.getDisplayMessages()
            this.emit({ type: 'agent_end' })
            break // exit retry loop

          } catch (err) {
            clearInterval(watchdog)
            this._state.streamingMessage = null

            // Check if error is retryable (duck typing for plugin errors)
            const category = (err as { category?: string })?.category as ErrorCategory | undefined
            const retryAfterMs = (err as { retryAfterMs?: number })?.retryAfterMs

            if (category && RETRYABLE_CATEGORIES.has(category) && attempt < MAX_RETRY_ATTEMPTS) {
              const delay = retryAfterMs ?? RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]
              this._state.retryState = {
                attempt: attempt + 1,
                maxAttempts: MAX_RETRY_ATTEMPTS,
                nextRetryAt: Date.now() + delay,
                lastError: (err as Error)?.message || String(err),
                category,
              }
              this.emit({
                type: 'retry_scheduled',
                attempt: attempt + 1,
                maxAttempts: MAX_RETRY_ATTEMPTS,
                delayMs: delay,
                error: (err as Error)?.message || String(err),
                category,
              })

              try {
                await this.retrySleep(delay)
              } catch {
                // skipRetryDelay or user abort — continue to next attempt
              }

              this.emit({ type: 'retry_attempt', attempt: attempt + 1, maxAttempts: MAX_RETRY_ATTEMPTS })
              continue
            }

            // Non-retryable or retries exhausted — add error to display
            const errorText = (err as Error)?.message || String(err)
            streamingBlocks.push({ type: 'error', text: errorText })
            const errorMessage: DisplayMessage = {
              role: 'assistant',
              blocks: streamingBlocks,
              timestamp: Date.now(),
            }
            this._state.messages = [...this._state.messages, errorMessage]
            this.emit({ type: 'agent_end' })
            break // exit retry loop
          }
        }

        // Check for queued follow-up messages
        const nextFollowUp = this.followUpQueue.shift()
        if (!nextFollowUp) break
        currentText = nextFollowUp
        currentFiles = undefined
      }
    } catch (err) {
      this._state.error = (err as Error)?.message || String(err)
      this.emit({ type: 'agent_end' })
    } finally {
      this._state.isStreaming = false
      this._state.streamingMessage = null
      this._state.retryState = null
      this._state.stalledSince = null
      this.toolAbortController = null
      this.emit({ type: 'agent_idle' })
      this.resolveRunningPrompt?.()
      this.runningPrompt = undefined
      this.resolveRunningPrompt = undefined
    }
  }

  private retrySleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.retryAbortController = new AbortController()
      const signal = this.retryAbortController.signal
      const timer = setTimeout(() => { this.retryAbortController = null; resolve() }, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        this.retryAbortController = null
        reject(new Error('retry sleep aborted'))
      }, { once: true })
    })
  }

  private emit(e: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(e)
      } catch (err) {
        console.error('[Agent] listener error:', err)
      }
    }
  }
}
