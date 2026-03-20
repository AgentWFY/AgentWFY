import type {
  AgentEvent,
  AgentState,
  ImageContent,
  TextContent,
} from './types.js'
import type {
  ProviderSession,
  ProviderOutput,
  DisplayMessage,
  Block,
} from './provider_types.js'
import { truncateHead, TOOL_RESULT_MAX_CHARS } from './truncate.js'

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
  private providerSession: ProviderSession
  private followUpQueue: string[] = []
  private runningPrompt?: Promise<void>
  private resolveRunningPrompt?: () => void

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
    this.providerSession.send({ type: 'abort' })
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
    this.followUpQueue = []
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing a prompt.')
    }
    await this.runLoop(text, images)
  }

  private async runLoop(text: string, images?: ImageContent[]): Promise<void> {
    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve
    })
    this._state.isStreaming = true
    this._state.streamingMessage = null
    this._state.error = undefined

    const session = this.providerSession

    try {
      this.emit({ type: 'agent_start' })

      let currentText = text
      let currentImages = images

      while (true) {
        // Add user message to local display
        const userBlocks: Block[] = [{ type: 'text', text: currentText }]
        if (currentImages) {
          for (const img of currentImages) {
            userBlocks.push({ type: 'image', mimeType: img.mimeType, data: img.data })
          }
        }
        this._state.messages = [...this._state.messages, { role: 'user', blocks: userBlocks, timestamp: Date.now() }]

        // Send to provider and process events
        await new Promise<void>((resolve) => {
          let streamingBlocks: Block[] = []

          const handleOutput = (event: ProviderOutput) => {
            switch (event.type) {
              case 'start':
                // If there are existing streaming blocks (from a previous turn with tool calls),
                // commit them as a completed message before starting a new streaming message.
                if (streamingBlocks.length > 0) {
                  const completedMessage: DisplayMessage = {
                    role: 'assistant',
                    blocks: streamingBlocks,
                    timestamp: Date.now(),
                  }
                  this._state.messages = [...this._state.messages, completedMessage]
                }
                streamingBlocks = []
                this._state.streamingMessage = { role: 'assistant', blocks: streamingBlocks, timestamp: Date.now() }
                this.emit({ type: 'stream_update' })
                break

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
                const code = event.code
                const description = event.description || 'Executing code'
                streamingBlocks.push({ type: 'exec_js', id: event.id, description, code })

                const tool = this._state.tools.find(t => t.name === 'execJs')
                if (!tool) {
                  session.send({
                    type: 'exec_js_result',
                    id: event.id,
                    content: [{ type: 'text', text: 'execJs tool not available' }],
                    isError: true,
                  })
                  break
                }

                tool.execute(event.id, { code, description })
                  .then((result) => {
                    const contextContent = result.content.map(c => {
                      if (c.type === 'text' && c.text.length > TOOL_RESULT_MAX_CHARS) {
                        return { ...c, text: truncateHead(c.text) }
                      }
                      return c
                    }) as (TextContent | ImageContent)[]

                    streamingBlocks.push({ type: 'exec_js_result', id: event.id, content: contextContent, isError: false })
                    this.emit({ type: 'stream_update' })

                    session.send({
                      type: 'exec_js_result',
                      id: event.id,
                      content: contextContent,
                      isError: false,
                    })
                  })
                  .catch((err) => {
                    const errorText = err instanceof Error ? err.message : String(err)

                    streamingBlocks.push({ type: 'exec_js_result', id: event.id, content: [{ type: 'text', text: errorText }], isError: true })
                    this.emit({ type: 'stream_update' })

                    session.send({
                      type: 'exec_js_result',
                      id: event.id,
                      content: [{ type: 'text', text: errorText }],
                      isError: true,
                    })
                  })
                this.emit({ type: 'stream_update' })
                break
              }

              case 'done': {
                session.off(handleOutput)
                this._state.streamingMessage = null

                // Provider is the source of truth for committed display messages.
                // It may have cleaned up intermediate steps or transformed messages.
                const providerMessages = session.getDisplayMessages()
                if (providerMessages instanceof Promise) {
                  // Async provider — fall back to locally built messages
                  const finalMessage: DisplayMessage = {
                    role: 'assistant',
                    blocks: streamingBlocks,
                    timestamp: Date.now(),
                  }
                  this._state.messages = [...this._state.messages, finalMessage]
                } else {
                  this._state.messages = providerMessages
                }

                this.emit({ type: 'agent_end' })
                resolve()
                break
              }

              case 'error': {
                session.off(handleOutput)
                streamingBlocks.push({ type: 'error', text: event.error })
                const errorMessage: DisplayMessage = {
                  role: 'assistant',
                  blocks: streamingBlocks,
                  timestamp: Date.now(),
                }
                this._state.streamingMessage = null
                this._state.messages = [...this._state.messages, errorMessage]
                this.emit({ type: 'agent_end' })
                resolve()
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

          session.on(handleOutput)
          session.send({
            type: 'user_message',
            text: currentText,
            images: currentImages,
          })
        })

        // Check for queued follow-up messages
        const nextFollowUp = this.followUpQueue.shift()
        if (!nextFollowUp) break
        currentText = nextFollowUp
        currentImages = undefined
      }
    } catch (err) {
      this._state.error = (err as Error)?.message || String(err)
      this.emit({ type: 'agent_end' })
    } finally {
      this._state.isStreaming = false
      this._state.streamingMessage = null
      this.emit({ type: 'agent_idle' })
      this.resolveRunningPrompt?.()
      this.runningPrompt = undefined
      this.resolveRunningPrompt = undefined
    }
  }

  private emit(e: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(e)
    }
  }
}
