import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from './types.js'
import type {
  ProviderSession,
  ProviderOutput,
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
    streamMessage: null,
    pendingToolCalls: new Set(),
    error: undefined,
  }

  private listeners = new Set<(e: AgentEvent) => void>()
  private providerSession: ProviderSession
  private steeringQueue: AgentMessage[] = []
  private followUpQueue: AgentMessage[] = []
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

  replaceMessages(ms: AgentMessage[]): void {
    this._state.messages = ms.slice()
  }

  appendMessage(m: AgentMessage): void {
    this._state.messages = [...this._state.messages, m]
  }

  clearMessages(): void {
    this._state.messages = []
  }

  steer(m: AgentMessage): void {
    this.steeringQueue.push(m)
  }

  followUp(m: AgentMessage): void {
    this.followUpQueue.push(m)
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
    this._state.streamMessage = null
    this._state.pendingToolCalls = new Set()
    this._state.error = undefined
    this.steeringQueue = []
    this.followUpQueue = []
  }

  async prompt(input: AgentMessage | AgentMessage[] | string, images?: ImageContent[]): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.')
    }

    let msgs: AgentMessage[]
    if (Array.isArray(input)) {
      msgs = input
    } else if (typeof input === 'string') {
      const content: (ImageContent | { type: 'text'; text: string })[] = [{ type: 'text', text: input }]
      if (images && images.length > 0) {
        content.push(...images)
      }
      msgs = [{ role: 'user', content, timestamp: Date.now() }]
    } else {
      msgs = [input]
    }

    await this.runLoop(msgs)
  }

  async continue(): Promise<void> {
    if (this._state.isStreaming) {
      throw new Error('Agent is already processing. Wait for completion before continuing.')
    }

    const messages = this._state.messages
    if (messages.length === 0) {
      throw new Error('No messages to continue from')
    }

    if (messages[messages.length - 1].role === 'assistant') {
      const steering = this.dequeueSteeringMessages()
      if (steering.length > 0) {
        await this.runLoop(steering)
        return
      }
      const followUps = this.dequeueFollowUpMessages()
      if (followUps.length > 0) {
        await this.runLoop(followUps)
        return
      }
      throw new Error('Cannot continue from message role: assistant')
    }

    await this.runLoop(undefined)
  }

  private dequeueOne(queue: 'steeringQueue' | 'followUpQueue'): AgentMessage[] {
    if (this[queue].length === 0) return []
    const [first, ...rest] = this[queue]
    this[queue] = rest
    return [first]
  }

  private dequeueSteeringMessages(): AgentMessage[] {
    return this.dequeueOne('steeringQueue')
  }

  private dequeueFollowUpMessages(): AgentMessage[] {
    return this.dequeueOne('followUpQueue')
  }

  private async runLoop(inputMessages?: AgentMessage[]): Promise<void> {
    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve
    })
    this._state.isStreaming = true
    this._state.streamMessage = null
    this._state.error = undefined

    const newMessages: AgentMessage[] = []
    const session = this.providerSession

    try {
      this.emit({ type: 'agent_start' })

      // Extract text and images from input messages
      let userText = ''
      let userImages: ImageContent[] | undefined
      if (inputMessages) {
        for (const msg of inputMessages) {
          newMessages.push(msg)
          this.appendMessage(msg)
          this.emit({ type: 'message_start', message: msg })
          this.emit({ type: 'message_end', message: msg })

          if (msg.role === 'user') {
            for (const c of (msg as UserMessage).content) {
              if (c.type === 'text') userText += c.text
              if (c.type === 'image') {
                if (!userImages) userImages = []
                userImages.push(c)
              }
            }
          }
        }
      }

      // Send user message to provider and process events
      await new Promise<void>((resolve) => {
        let currentAssistantText = ''
        let currentThinkingText = ''
        const pendingExecJs = new Map<string, { code: string }>()

        const handleOutput = (event: ProviderOutput) => {
          switch (event.type) {
            case 'start':
              this.emit({ type: 'turn_start' })
              currentAssistantText = ''
              currentThinkingText = ''
              break

            case 'text_delta': {
              currentAssistantText += event.delta
              const partialMsg = this.buildPartialMessage(currentAssistantText, currentThinkingText)
              this._state.streamMessage = partialMsg
              this.emit({
                type: 'message_update',
                streamEvent: {
                  type: 'text_delta',
                  contentIndex: 0,
                  delta: event.delta,
                  partial: partialMsg,
                },
                message: partialMsg,
              })
              break
            }

            case 'thinking_delta': {
              currentThinkingText += event.delta
              const partialMsg = this.buildPartialMessage(currentAssistantText, currentThinkingText)
              this._state.streamMessage = partialMsg
              this.emit({
                type: 'message_update',
                streamEvent: {
                  type: 'thinking_delta',
                  contentIndex: 0,
                  delta: event.delta,
                  partial: partialMsg,
                },
                message: partialMsg,
              })
              break
            }

            case 'exec_js_start':
              pendingExecJs.set(event.id, { code: '' })
              this.emit({
                type: 'tool_execution_start',
                toolCallId: event.id,
                toolName: 'execJs',
                args: {},
              })
              break

            case 'exec_js_delta': {
              const entry = pendingExecJs.get(event.id)
              if (entry) entry.code += event.delta
              break
            }

            case 'exec_js_end': {
              const entry = pendingExecJs.get(event.id)
              const code = entry?.code ?? ''

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

              tool.execute(event.id, { code, description: 'Executing code' })
                .then((result) => {
                  this.emit({
                    type: 'tool_execution_end',
                    toolCallId: event.id,
                    toolName: 'execJs',
                    result,
                    isError: false,
                  })

                  const contextContent = result.content.map(c => {
                    if (c.type === 'text' && c.text.length > TOOL_RESULT_MAX_CHARS) {
                      return { ...c, text: truncateHead(c.text) }
                    }
                    return c
                  }) as (TextContent | ImageContent)[]

                  session.send({
                    type: 'exec_js_result',
                    id: event.id,
                    content: contextContent,
                    isError: false,
                  })
                })
                .catch((err) => {
                  const errorText = err instanceof Error ? err.message : String(err)
                  this.emit({
                    type: 'tool_execution_end',
                    toolCallId: event.id,
                    toolName: 'execJs',
                    result: { content: [{ type: 'text', text: errorText }], details: {} },
                    isError: true,
                  })
                  session.send({
                    type: 'exec_js_result',
                    id: event.id,
                    content: [{ type: 'text', text: errorText }],
                    isError: true,
                  })
                })
              break
            }

            case 'done': {
              session.off(handleOutput)
              const finalMsg = this.buildPartialMessage(currentAssistantText, currentThinkingText)
              finalMsg.stopReason = 'end'
              this._state.streamMessage = null
              this.appendMessage(finalMsg)
              this.emit({ type: 'message_start', message: finalMsg })
              this.emit({ type: 'message_end', message: finalMsg })
              newMessages.push(finalMsg)
              this.emit({ type: 'turn_end', message: finalMsg, toolResults: [] })
              this.emit({ type: 'agent_end', messages: newMessages })
              resolve()
              break
            }

            case 'error': {
              session.off(handleOutput)
              const errorMsg = this.buildPartialMessage(currentAssistantText, currentThinkingText)
              errorMsg.stopReason = 'error'
              errorMsg.errorMessage = event.error
              this._state.streamMessage = null
              this._state.error = event.error
              this.appendMessage(errorMsg)
              this.emit({ type: 'message_start', message: errorMsg })
              this.emit({ type: 'message_end', message: errorMsg })
              newMessages.push(errorMsg)
              this.emit({ type: 'turn_end', message: errorMsg, toolResults: [] })
              this.emit({ type: 'agent_end', messages: newMessages })
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
          text: userText,
          images: userImages,
        })
      })
    } catch (err) {
      this._state.error = (err as Error)?.message || String(err)
      this.emit({ type: 'agent_end', messages: newMessages })
    } finally {
      this._state.isStreaming = false
      this._state.streamMessage = null
      this._state.pendingToolCalls = new Set()
      this.emit({ type: 'agent_idle' })
      this.resolveRunningPrompt?.()
      this.runningPrompt = undefined
      this.resolveRunningPrompt = undefined
    }
  }

  private buildPartialMessage(text: string, thinking: string): AssistantMessage {
    const content: AssistantMessage['content'] = []
    if (thinking) {
      content.push({ type: 'thinking', thinking })
    }
    if (text || content.length === 0) {
      content.push({ type: 'text', text: text || '' })
    }
    return {
      role: 'assistant',
      content,
      provider: '',
      model: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'end',
      timestamp: Date.now(),
    }
  }

  private emit(e: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(e)
    }
  }
}
