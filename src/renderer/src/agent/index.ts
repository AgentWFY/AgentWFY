import type {
  AgentEvent,
  AgentState,
  AgentTool,
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

export interface AgentOptions {
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
  private steeringQueue: string[] = []
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

  async getProviderDisplayMessages(): Promise<DisplayMessage[]> {
    return await this.providerSession.getDisplayMessages() as DisplayMessage[]
  }

  replaceMessages(ms: DisplayMessage[]): void {
    this._state.messages = ms.slice()
  }

  clearMessages(): void {
    this._state.messages = []
  }

  steer(text: string): void {
    this.steeringQueue.push(text)
  }

  followUp(text: string): void {
    this.followUpQueue.push(text)
  }

  abort(): void {
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
    this.steeringQueue = []
    this.followUpQueue = []
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing a prompt.')
    }
    await this.runLoop(text, images)
  }

  private dequeueSteering(): string | undefined {
    return this.steeringQueue.shift()
  }

  private dequeueFollowUp(): string | undefined {
    return this.followUpQueue.shift()
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

      // Add user message to local display
      const userBlocks: Block[] = [{ type: 'text', text }]
      if (images) {
        for (const img of images) {
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
              const finalMessage: DisplayMessage = {
                role: 'assistant',
                blocks: streamingBlocks,
                timestamp: Date.now(),
              }
              this._state.streamingMessage = null
              this._state.messages = [...this._state.messages, finalMessage]
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
          }
        }

        session.on(handleOutput)
        session.send({
          type: 'user_message',
          text,
          images,
        })
      })
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
