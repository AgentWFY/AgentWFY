import {
  streamSimple,
  validateToolArguments,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai'
import type { AgentEvent, AgentMessage, AgentState, ThinkingLevel } from './types'

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  ) as Message[]
}

export interface AgentOptions {
  initialState?: Partial<AgentState>
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>
  sessionId?: string
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
}

export class Agent {
  private _state: AgentState = {
    systemPrompt: '',
    model: undefined as unknown as Model<unknown>,
    thinkingLevel: 'off',
    tools: [],
    messages: [],
    isStreaming: false,
    streamMessage: null,
    pendingToolCalls: new Set(),
    error: undefined,
  }

  private listeners = new Set<(e: AgentEvent) => void>()
  private abortController?: AbortController
  private convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>
  private steeringQueue: AgentMessage[] = []
  private followUpQueue: AgentMessage[] = []
  private runningPrompt?: Promise<void>
  private resolveRunningPrompt?: () => void

  sessionId?: string
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined

  constructor(opts: AgentOptions = {}) {
    if (opts.initialState) {
      Object.assign(this._state, opts.initialState)
    }
    this.convertToLlm = opts.convertToLlm || defaultConvertToLlm
    this.sessionId = opts.sessionId
    this.getApiKey = opts.getApiKey
  }

  get state(): AgentState {
    return this._state
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setModel(m: Model<unknown>): void {
    this._state.model = m
  }

  setThinkingLevel(l: ThinkingLevel): void {
    this._state.thinkingLevel = l
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
    this.abortController?.abort()
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
        await this.runLoop(steering, { skipInitialSteeringPoll: true })
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

  private dequeueSteeringMessages(): AgentMessage[] {
    if (this.steeringQueue.length > 0) {
      const first = this.steeringQueue[0]
      this.steeringQueue = this.steeringQueue.slice(1)
      return [first]
    }
    return []
  }

  private dequeueFollowUpMessages(): AgentMessage[] {
    if (this.followUpQueue.length > 0) {
      const first = this.followUpQueue[0]
      this.followUpQueue = this.followUpQueue.slice(1)
      return [first]
    }
    return []
  }

  private async runLoop(
    inputMessages?: AgentMessage[],
    options?: { skipInitialSteeringPoll?: boolean },
  ): Promise<void> {
    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve
    })
    this.abortController = new AbortController()
    this._state.isStreaming = true
    this._state.streamMessage = null
    this._state.error = undefined

    const contextMessages = this._state.messages.slice()
    const newMessages: AgentMessage[] = []

    try {
      this.emit({ type: 'agent_start' })

      // Add input messages to context
      if (inputMessages) {
        for (const msg of inputMessages) {
          contextMessages.push(msg)
          newMessages.push(msg)
          this.emit({ type: 'message_start', message: msg })
          this.emit({ type: 'message_end', message: msg })
        }
        this._state.messages = contextMessages.slice()
      }

      let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true
      let pendingMessages = skipInitialSteeringPoll
        ? []
        : this.dequeueSteeringMessages()
      skipInitialSteeringPoll = false

      // Outer loop: continues when follow-up messages arrive
      outer: while (true) {
        let hasMoreToolCalls = true
        let steeringAfterTools: AgentMessage[] | null = null

        // Inner loop: process tool calls and steering messages
        while (hasMoreToolCalls || pendingMessages.length > 0) {
          this.emit({ type: 'turn_start' })

          // Inject pending messages before next LLM call
          if (pendingMessages.length > 0) {
            for (const msg of pendingMessages) {
              this.emit({ type: 'message_start', message: msg })
              this.emit({ type: 'message_end', message: msg })
              contextMessages.push(msg)
              newMessages.push(msg)
            }
            this._state.messages = contextMessages.slice()
            pendingMessages = []
          }

          // Stream assistant response
          const assistantMessage = await this.streamAssistantResponse(
            contextMessages,
            this.abortController.signal,
          )
          newMessages.push(assistantMessage)

          if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') {
            this.emit({ type: 'turn_end', message: assistantMessage, toolResults: [] })
            this.emit({ type: 'agent_end', messages: newMessages })
            break outer
          }

          // Check for tool calls
          const toolCalls = assistantMessage.content.filter(
            (c): c is ToolCall => c.type === 'toolCall',
          )
          hasMoreToolCalls = toolCalls.length > 0
          const toolResults: ToolResultMessage[] = []

          if (hasMoreToolCalls) {
            const execution = await this.executeToolCalls(
              toolCalls,
              contextMessages,
              newMessages,
              this.abortController.signal,
            )
            toolResults.push(...execution.toolResults)
            steeringAfterTools = execution.steeringMessages ?? null
          }

          this.emit({ type: 'turn_end', message: assistantMessage, toolResults })

          // Get steering messages after turn completes
          if (steeringAfterTools && steeringAfterTools.length > 0) {
            pendingMessages = steeringAfterTools
            steeringAfterTools = null
          } else {
            pendingMessages = this.dequeueSteeringMessages()
          }
        }

        // Agent would stop. Check for follow-up messages.
        const followUpMessages = this.dequeueFollowUpMessages()
        if (followUpMessages.length > 0) {
          pendingMessages = followUpMessages
          continue
        }

        // No more messages, exit
        this.emit({ type: 'agent_end', messages: newMessages })
        break
      }
    } catch (err) {
      const model = this._state.model
      const errorMsg: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: model?.api ?? '',
        provider: model?.provider ?? '',
        model: model?.id ?? '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: this.abortController?.signal.aborted ? 'aborted' : 'error',
        errorMessage: (err as Error)?.message || String(err),
        timestamp: Date.now(),
      }
      this.appendMessage(errorMsg)
      this._state.error = (err as Error)?.message || String(err)
      this.emit({ type: 'agent_end', messages: [errorMsg] })
    } finally {
      this._state.isStreaming = false
      this._state.streamMessage = null
      this._state.pendingToolCalls = new Set()
      this.abortController = undefined
      this.emit({ type: 'agent_idle' })
      this.resolveRunningPrompt?.()
      this.runningPrompt = undefined
      this.resolveRunningPrompt = undefined
    }
  }

  private async streamAssistantResponse(
    contextMessages: AgentMessage[],
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const llmMessages = await this.convertToLlm(contextMessages)
    const llmContext: Context = {
      systemPrompt: this._state.systemPrompt,
      messages: llmMessages,
      tools: this._state.tools,
    }

    const reasoning = this._state.thinkingLevel === 'off' ? undefined : this._state.thinkingLevel
    const resolvedApiKey = this.getApiKey
      ? await this.getApiKey(this._state.model.provider)
      : undefined

    const response: AssistantMessageEventStream = streamSimple(this._state.model, llmContext, {
      reasoning,
      sessionId: this.sessionId,
      apiKey: resolvedApiKey,
      signal,
    })

    let partialMessage: AssistantMessage | null = null
    let addedPartial = false

    for await (const event of response) {
      switch (event.type) {
        case 'start':
          partialMessage = event.partial
          contextMessages.push(partialMessage)
          addedPartial = true
          this._state.streamMessage = partialMessage
          this._state.messages = contextMessages.slice()
          this.emit({ type: 'message_start', message: { ...partialMessage } })
          break

        case 'text_start':
        case 'text_delta':
        case 'text_end':
        case 'thinking_start':
        case 'thinking_delta':
        case 'thinking_end':
        case 'toolcall_start':
        case 'toolcall_delta':
        case 'toolcall_end':
          if (partialMessage) {
            partialMessage = event.partial
            contextMessages[contextMessages.length - 1] = partialMessage
            this._state.streamMessage = partialMessage
            this._state.messages = contextMessages.slice()
            this.emit({
              type: 'message_update',
              assistantMessageEvent: event,
              message: { ...partialMessage },
            })
          }
          break

        case 'done':
        case 'error': {
          const finalMessage = await response.result()
          if (addedPartial) {
            contextMessages[contextMessages.length - 1] = finalMessage
          } else {
            contextMessages.push(finalMessage)
          }
          this._state.streamMessage = null
          this._state.messages = contextMessages.slice()
          if (!addedPartial) {
            this.emit({ type: 'message_start', message: { ...finalMessage } })
          }
          this.emit({ type: 'message_end', message: finalMessage })
          return finalMessage
        }
      }
    }

    // Shouldn't reach here normally, but handle gracefully
    return response.result()
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    contextMessages: AgentMessage[],
    newMessages: AgentMessage[],
    signal: AbortSignal,
  ): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
    const results: ToolResultMessage[] = []
    let steeringMessages: AgentMessage[] | undefined

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i]
      const tool = this._state.tools.find((t) => t.name === toolCall.name)

      this.emit({
        type: 'tool_execution_start',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
      })

      const pendingSet = new Set(this._state.pendingToolCalls)
      pendingSet.add(toolCall.id)
      this._state.pendingToolCalls = pendingSet

      let result: { content: { type: string; text: string }[]; details: unknown }
      let isError = false

      try {
        if (!tool) throw new Error(`Tool ${toolCall.name} not found`)
        const validatedArgs = validateToolArguments(tool, toolCall)
        result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
          this.emit({
            type: 'tool_execution_update',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
            partialResult,
          })
        })
      } catch (e) {
        result = {
          content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
          details: {},
        }
        isError = true
      }

      const doneSet = new Set(this._state.pendingToolCalls)
      doneSet.delete(toolCall.id)
      this._state.pendingToolCalls = doneSet

      this.emit({
        type: 'tool_execution_end',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        isError,
      })

      const toolResultMessage: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content as ToolResultMessage['content'],
        details: result.details,
        isError,
        timestamp: Date.now(),
      }
      results.push(toolResultMessage)
      contextMessages.push(toolResultMessage)
      newMessages.push(toolResultMessage)
      this._state.messages = contextMessages.slice()

      this.emit({ type: 'message_start', message: toolResultMessage })
      this.emit({ type: 'message_end', message: toolResultMessage })

      // Check for steering messages — skip remaining tools if user interrupted
      const steering = this.dequeueSteeringMessages()
      if (steering.length > 0) {
        steeringMessages = steering
        // Skip remaining tool calls
        for (const skipped of toolCalls.slice(i + 1)) {
          const skippedResult = this.skipToolCall(skipped, contextMessages, newMessages)
          results.push(skippedResult)
        }
        break
      }
    }

    return { toolResults: results, steeringMessages }
  }

  private skipToolCall(
    toolCall: ToolCall,
    contextMessages: AgentMessage[],
    newMessages: AgentMessage[],
  ): ToolResultMessage {
    const result = {
      content: [{ type: 'text' as const, text: 'Skipped due to queued user message.' }],
      details: {},
    }

    this.emit({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    })
    this.emit({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError: true,
    })

    const toolResultMessage: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: {},
      isError: true,
      timestamp: Date.now(),
    }
    contextMessages.push(toolResultMessage)
    newMessages.push(toolResultMessage)
    this._state.messages = contextMessages.slice()

    this.emit({ type: 'message_start', message: toolResultMessage })
    this.emit({ type: 'message_end', message: toolResultMessage })

    return toolResultMessage
  }

  private emit(e: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(e)
    }
  }
}
