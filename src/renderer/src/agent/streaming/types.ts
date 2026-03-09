import type { AgentTool, AssistantMessage, Message, Model, StopReason, StreamEvent, ThinkingLevel } from '../types.js'

export type { StreamEvent }

export interface StreamContext {
  systemPrompt: string
  messages: Message[]
  tools: AgentTool[]
}

export interface StreamOptions {
  reasoning?: ThinkingLevel | undefined
  sessionId?: string
  apiKey?: string
  signal?: AbortSignal
  maxTokens?: number
}

export class MessageStream implements AsyncIterable<StreamEvent> {
  private events: StreamEvent[] = []
  private resolve: ((value: IteratorResult<StreamEvent>) => void) | null = null
  private done = false
  private _result: AssistantMessage | null = null
  private resultResolve: ((msg: AssistantMessage) => void) | null = null
  private resultPromise: Promise<AssistantMessage>

  constructor() {
    this.resultPromise = new Promise<AssistantMessage>((resolve) => {
      this.resultResolve = resolve
    })
  }

  push(event: StreamEvent): void {
    if (event.type === 'done' || event.type === 'error') {
      this._result = event.partial
      this.resultResolve?.(event.partial)
      this.resultResolve = null
    }

    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      r({ value: event, done: false })
    } else {
      this.events.push(event)
    }

    if (event.type === 'done' || event.type === 'error') {
      this.done = true
    }
  }

  async result(): Promise<AssistantMessage> {
    return this.resultPromise
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        if (this.events.length > 0) {
          return Promise.resolve({ value: this.events.shift()!, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true })
        }
        return new Promise<IteratorResult<StreamEvent>>((resolve) => {
          this.resolve = resolve
        })
      },
    }
  }
}

export function emitError(
  stream: MessageStream,
  model: Model,
  errorMessage: string,
  stopReason: StopReason = 'error',
): void {
  stream.push({
    type: 'error',
    error: errorMessage,
    partial: {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      provider: model.provider.id,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason,
      errorMessage,
      timestamp: Date.now(),
    },
  })
}

export function createStream(model: Model, context: StreamContext, options: StreamOptions): MessageStream {
  const stream = new MessageStream()

  switch (model.provider.api) {
    case 'openai-completions': {
      import('./openai.js').then((mod) => mod.streamOpenAI(stream, model, context, options))
        .catch((err) => emitError(stream, model, err instanceof Error ? err.message : String(err)))
      break
    }
    case 'anthropic-messages': {
      import('./anthropic.js').then((mod) => mod.streamAnthropic(stream, model, context, options))
        .catch((err) => emitError(stream, model, err instanceof Error ? err.message : String(err)))
      break
    }
    case 'openai-codex-responses': {
      import('./codex.js').then((mod) => mod.streamCodex(stream, model, context, options))
        .catch((err) => emitError(stream, model, err instanceof Error ? err.message : String(err)))
      break
    }
    default:
      emitError(stream, model, `Unsupported API type: ${model.provider.api}`)
  }

  return stream
}
