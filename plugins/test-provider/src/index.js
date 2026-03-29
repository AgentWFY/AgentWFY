/**
 * Test provider plugin for verifying session resilience.
 * Simulates various failure modes triggered by message commands.
 */

class ProviderError extends Error {
  constructor(message, category, retryAfterMs) {
    super(message)
    this.name = 'ProviderError'
    this.category = category
    this.retryAfterMs = retryAfterMs
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    }
  })
}

class TestSession {
  constructor(config, restored) {
    this._config = config
    this._messages = restored?.messages || []
    this._displayMessages = restored?.displayMessages || []
    this._abortController = null
    this._failCount = 0 // tracks consecutive fails for multi-fail scenario
  }

  async *stream(input, executeTool) {
    this._messages.push({ role: 'user', content: input.text })
    this._displayMessages.push({
      role: 'user',
      blocks: [{ type: 'text', text: input.text }],
      timestamp: Date.now(),
    })
    yield { type: 'state_changed' }
    yield* this._doStream(input.text.trim().toLowerCase(), executeTool)
  }

  async *retry(executeTool) {
    // Discard partial assistant state
    while (this._messages.length > 0 && this._messages[this._messages.length - 1].role === 'assistant') {
      this._messages.pop()
    }
    if (this._displayMessages.length > 0 && this._displayMessages[this._displayMessages.length - 1] === this._partial) {
      this._displayMessages.pop()
    }
    this._partial = null

    // For multi-fail: re-derive command from last user message
    const lastUser = this._messages.findLast(m => m.role === 'user')
    const command = lastUser?.content?.trim().toLowerCase() || ''
    yield* this._doStream(command, executeTool)
  }

  async *_doStream(command, executeTool) {
    this._abortController = new AbortController()
    const signal = this._abortController.signal

    yield { type: 'status_line', text: 'Test Provider' }

    switch (command) {
      case 'normal':
        yield* this._streamNormal(signal)
        break
      case 'network':
        yield* this._streamNetworkError(signal)
        break
      case 'timeout':
        yield* this._streamTimeout(signal)
        break
      case 'ratelimit':
        this._commitEmpty()
        throw new ProviderError('Rate limited by test provider', 'rate_limit', 10_000)
      case 'auth':
        this._commitEmpty()
        throw new ProviderError('Authentication failed (test)', 'auth')
      case 'overflow':
        this._commitEmpty()
        throw new ProviderError('Prompt is too long (test)', 'context_overflow')
      case 'tools':
        yield* this._streamWithTools(signal, executeTool)
        break
      case 'thinking':
        yield* this._streamLongThinking(signal)
        break
      case 'slow':
        yield* this._streamSlow(signal)
        break
      case 'multi-fail':
        yield* this._streamMultiFail(signal)
        break
      default:
        yield* this._streamEcho(command || 'Hello!', signal)
        break
    }
  }

  async *_streamNormal(signal) {
    const thinking = 'Let me think about this... Analyzing the request. Formulating a response.'
    for (const char of thinking) {
      if (signal.aborted) return
      yield { type: 'thinking_delta', delta: char }
      await sleep(10, signal).catch(() => {})
      if (signal.aborted) return
    }

    const text = 'This is a normal response from the test provider. Everything is working correctly. The stream completed without any errors.'
    yield* this._streamText(text, signal, 20)

    this._commitAssistant(text, thinking)
    yield { type: 'status_line', text: 'Test Provider · 150 tokens' }
    yield { type: 'state_changed' }
  }

  async *_streamNetworkError(signal) {
    const partial = 'Starting to stream a response, but then...'
    yield* this._streamText(partial, signal, 30)

    // Simulate mid-stream network failure
    if (signal.aborted) return
    await sleep(200, signal).catch(() => {})
    if (signal.aborted) return

    throw new ProviderError('Connection reset by peer (simulated)', 'network')
  }

  async *_streamTimeout(signal) {
    const partial = 'This response will go silent after a few words...'
    yield* this._streamText(partial, signal, 30)

    // Go completely silent — the agent's watchdog should detect this
    // Wait indefinitely (until aborted)
    try {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    } catch {
      // aborted
      return
    }
  }

  async *_streamWithTools(signal, executeTool) {
    const intro = 'Let me run some code for you.'
    yield* this._streamText(intro, signal, 20)

    // Tool call
    const toolCall = { id: 'test-tool-1', description: 'Test tool execution', code: 'return "Hello from tool!"' }
    yield { type: 'exec_js', id: toolCall.id, description: toolCall.description, code: toolCall.code }

    const result = await executeTool(toolCall)

    // Add tool interaction to messages
    this._messages.push({ role: 'assistant', content: intro, toolCall })
    this._messages.push({ role: 'tool', id: toolCall.id, content: result.content })

    yield { type: 'state_changed' }

    // Continue after tool
    const outro = `\n\nThe tool returned: ${result.content.map(c => c.type === 'text' ? c.text : '').join('')}. Tool execution through the async iterator interface works!`
    yield* this._streamText(outro, signal, 20)

    const fullText = intro + outro
    this._displayMessages.push({
      role: 'assistant',
      blocks: [
        { type: 'text', text: intro },
        { type: 'exec_js', id: toolCall.id, description: toolCall.description, code: toolCall.code },
        { type: 'exec_js_result', id: toolCall.id, content: result.content, isError: result.isError },
        { type: 'text', text: outro },
      ],
      timestamp: Date.now(),
    })
    this._partial = null
    yield { type: 'state_changed' }
  }

  async *_streamLongThinking(signal) {
    // Simulate a provider where the server thinks for 15 seconds before first token
    // Emits periodic status_line to prevent watchdog false positives
    for (let i = 0; i < 15; i++) {
      if (signal.aborted) return
      yield { type: 'status_line', text: `Test Provider · thinking... ${i + 1}s` }
      await sleep(1000, signal).catch(() => {})
      if (signal.aborted) return
    }

    const text = 'Done thinking! After 15 seconds of server-side thinking, the response arrived. The waiting indicator should have shown during that time, and the watchdog should NOT have fired because status_line events were emitted as keepalives.'
    yield* this._streamText(text, signal, 20)

    this._commitAssistant(text)
    yield { type: 'state_changed' }
  }

  async *_streamSlow(signal) {
    const words = 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.'.split(' ')
    let text = ''
    for (const word of words) {
      if (signal.aborted) return
      const chunk = (text ? ' ' : '') + word
      text += chunk
      yield { type: 'text_delta', delta: chunk }
      yield { type: 'status_line', text: `Test Provider · streaming slowly...` }
      await sleep(1000, signal).catch(() => {})
      if (signal.aborted) return
    }

    this._commitAssistant(text)
    yield { type: 'state_changed' }
  }

  async *_streamMultiFail(signal) {
    this._failCount++

    if (this._failCount <= 3) {
      const partial = `Attempt ${this._failCount}: starting to stream...`
      yield* this._streamText(partial, signal, 20)
      await sleep(100, signal).catch(() => {})
      if (signal.aborted) return
      throw new ProviderError(`Network error on attempt ${this._failCount} (simulated)`, 'network')
    }

    // 4th attempt succeeds
    this._failCount = 0
    const text = 'Success! After 3 failures, the 4th retry attempt succeeded. The retry mechanism with exponential backoff is working correctly.'
    yield* this._streamText(text, signal, 20)

    this._commitAssistant(text)
    yield { type: 'state_changed' }
  }

  async *_streamEcho(text, signal) {
    const response = `Echo: ${text}`
    yield* this._streamText(response, signal, 15)

    this._commitAssistant(response)
    yield { type: 'state_changed' }
  }

  /** Stream text character by character with delay */
  async *_streamText(text, signal, delayMs = 20) {
    // Stream in small chunks (2-5 chars) for realistic feel
    for (let i = 0; i < text.length; ) {
      if (signal.aborted) return
      const chunkSize = Math.min(2 + Math.floor(Math.random() * 4), text.length - i)
      const chunk = text.slice(i, i + chunkSize)
      yield { type: 'text_delta', delta: chunk }
      i += chunkSize
      if (i < text.length) {
        await sleep(delayMs, signal).catch(() => {})
        if (signal.aborted) return
      }
    }
  }

  _commitAssistant(text, thinking) {
    this._messages.push({ role: 'assistant', content: text })
    const blocks = []
    if (thinking) blocks.push({ type: 'thinking', text: thinking })
    blocks.push({ type: 'text', text })
    this._displayMessages.push({ role: 'assistant', blocks, timestamp: Date.now() })
    this._partial = null
  }

  _commitEmpty() {
    // For errors that happen before streaming starts
  }

  abort() {
    if (this._abortController) this._abortController.abort()
  }

  dispose() {
    this.abort()
  }

  getDisplayMessages() {
    return this._displayMessages.slice()
  }

  getState() {
    return {
      messages: this._messages.slice(),
      displayMessages: this._displayMessages.slice(),
    }
  }

  getTitle() {
    const first = this._messages.find(m => m.role === 'user')
    return first ? `Test: ${first.content.slice(0, 50)}` : undefined
  }
}

module.exports = {
  activate(api) {
    api.registerProvider({
      id: 'test-provider',
      name: 'Test Provider',

      getStatusLine() {
        return 'Test Provider · Ready'
      },

      createSession(config) {
        return new TestSession(config)
      },

      restoreSession(config, state) {
        return new TestSession(config, state)
      },
    })
  },
}
