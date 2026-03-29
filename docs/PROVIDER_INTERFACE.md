# Provider Interface

Contract between the agent core and LLM provider plugins.

## Types

### ProviderFactory

```ts
interface ProviderFactory {
  id: string
  name: string
  settingsView?: string              // view name for settings UI (gear icon)
  getStatusLine?(): string           // status shown before any session exists
  createSession(config: ProviderSessionConfig): ProviderSession
  restoreSession(config: ProviderSessionConfig, state: unknown): ProviderSession
}

interface ProviderSessionConfig {
  sessionId: string
  systemPrompt: string
  tools: ReadonlyArray<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}
```

### ProviderSession

```ts
interface ProviderSession {
  stream(input: UserInput, executeTool: ToolExecutor): AsyncIterable<StreamEvent>
  retry(executeTool: ToolExecutor): AsyncIterable<StreamEvent>
  abort(): void
  getDisplayMessages(): DisplayMessage[]
  getState(): unknown
  getTitle?(): string
  dispose(): void
}
```

**`stream()`** — Start a turn. Adds the user message to internal state, calls the LLM API, and yields streaming events. When the LLM requests a tool call, the provider calls `executeTool()` and uses the result to continue. The iterator completes when the turn is done. Throws `ProviderError` on failure.

**`retry()`** — Retry the last failed turn. Discards any partial assistant response from the failed attempt and re-calls the API with the existing message history. Same return type as `stream()`.

**`abort()`** — Cancel the current stream. The iterator should complete promptly (not throw).

**`getDisplayMessages()`** — Returns the conversation for UI display and persistence. Always synchronous. Called after each completed turn and on session restore.

**`getState()`** — Returns a JSON-serializable blob for session persistence. Passed back to `restoreSession()` on restore. May be called at any time, including after an error — return the last consistent state.

**`dispose()`** — Clean up resources (timers, connections, abort controllers).

### UserInput

```ts
type UserInput = { text: string; files?: FileContent[] }
```

### Tool Execution

Tool execution is a callback, not a message. The provider calls it and awaits the result.

```ts
type ToolExecutor = (call: ToolCall) => Promise<ToolResult>
type ToolCall = { id: string; description: string; code: string; timeoutMs?: number }
type ToolResult = { content: (TextContent | FileContent)[]; isError: boolean }
```

### StreamEvent

```ts
type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'status_line'; text: string }
  | { type: 'state_changed' }
```

No `start`, `done`, or `error` events. Iterator completion = done. Thrown `ProviderError` = error.

`exec_js` is yielded for UI display when the provider parses a tool call from the stream, right before calling `executeTool()`. The tool result display is handled by the agent via the callback.

### ProviderError

```ts
class ProviderError extends Error {
  category: ErrorCategory
  retryAfterMs?: number      // optional hint from Retry-After header
}

type ErrorCategory =
  | 'network'           // connection failed, timeout, DNS
  | 'rate_limit'        // 429
  | 'server'            // 5xx, 529, overload
  | 'auth'              // 401/403
  | 'invalid_request'   // 400
  | 'content_policy'    // content filtered by model
  | 'context_overflow'  // prompt exceeds context window
```

`category` is required. The agent uses it to decide what to do:

| Category | Agent action |
|---|---|
| `network`, `rate_limit`, `server` | Retry with backoff |
| `auth`, `invalid_request`, `content_policy` | Stop. Show error to user. |
| `context_overflow` | Compact old messages, then retry. |

### DisplayMessage

```ts
interface DisplayMessage {
  role: 'user' | 'assistant'
  blocks: Block[]
  timestamp: number
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'file'; mimeType: string; data: string }
  | { type: 'attachment'; label: string; size: number; content: string }
  | { type: 'exec_js'; id: string; description: string; code: string }
  | { type: 'exec_js_result'; id: string; content: (TextContent | FileContent)[]; isError: boolean }
  | { type: 'error'; text: string }
```

---

## Event Flows

### Normal turn

```
agent calls session.stream({ text: '...' }, executeTool)
  provider yields 'text_delta'        (repeated)
  provider yields 'exec_js'           (0 or more tool calls)
  provider awaits executeTool(call)    (agent executes, returns result)
  provider yields 'text_delta'        (continued response)
  provider yields 'state_changed'
  iterator completes                  (done)
```

### Turn with tool calls

```
agent calls session.stream({ text: 'list files' }, executeTool)
  provider → yield { type: 'text_delta', delta: 'Let me check...' }
  provider → yield { type: 'exec_js', id: '1', code: 'return ls()', description: 'List files' }
  provider → const result = await executeTool({ id: '1', code: '...', description: '...' })
  provider → yield { type: 'state_changed' }
  ...provider calls API again with tool result...
  provider → yield { type: 'text_delta', delta: 'Here are the files...' }
  provider → yield { type: 'state_changed' }
  iterator completes
```

### Abort

```
agent calls session.abort()
  provider cancels in-flight request
  iterator completes (returns, does not throw)
```

### Error → retry

```
agent calls session.stream({ text: '...' }, executeTool)
  provider → yield { type: 'text_delta', delta: 'partial...' }
  ...connection dies...
  provider → throw new ProviderError('Connection lost', { category: 'network' })

  ← agent waits with backoff →

agent calls session.retry(executeTool)
  provider discards partial response, re-calls API
  provider → yield { type: 'text_delta', delta: '...' }
  iterator completes
```

---

## Idle Timeout

The agent runs a watchdog during streaming. If no stream event is yielded and no tool execution is active for **90 seconds**, the agent treats it as a dead connection: calls `abort()`, then `retry()`.

To prevent false timeouts during long server-side processing (extended thinking), emit `status_line` periodically. Any yielded event resets the timer.

```js
yield { type: 'status_line', text: 'claude-sonnet-4-6 · thinking...' }
```

Tool execution does not trigger the timeout — the agent knows the provider is waiting on a tool result and pauses the watchdog.

If your API sends SSE keepalive comments (`: ping`), convert them to `status_line` events.

---

## Agent Retry Behavior

After a retryable error (`network`, `rate_limit`, `server`), the agent retries with exponential backoff: 5s → 15s → 45s → 2min → 5min (capped). Max 10 attempts. After exhausting retries, the error is shown with a manual retry option.

Providers should keep their own fast retry for transient HTTP errors (2-3 attempts, short backoff). Throw `ProviderError` only after internal retry is exhausted. The agent's retry is the second tier for sustained outages.

---

## Rules

1. **Abort must not throw.** When `abort()` is called, the iterator should complete normally (return), not throw. Abort is not a failure.

2. **Errors are thrown, not yielded.** Throw `ProviderError` with a `category`. Never yield an error event.

3. **`retry()` discards partial state.** Remove any uncommitted assistant message or incomplete tool calls from the failed attempt. Re-call the API with the current message history.

4. **Don't yield `state_changed` during tool execution.** Only yield it after tool results are committed. Persisting mid-tool-call corrupts state on restore.

5. **`getDisplayMessages()` is always sync.** The provider must have display messages ready at all times.

6. **`getState()` survives errors.** If called after a thrown error, return the last consistent state (before the failed attempt).

---

## Example

```js
class MySession {
  constructor(config, providerConfig, restored) {
    this.systemPrompt = config.systemPrompt
    this.tools = config.tools
    this.providerConfig = providerConfig
    this.messages = restored?.messages || []
    this.displayMessages = restored?.displayMessages || []
    this.controller = null
  }

  async *stream(input, executeTool) {
    // Commit user message
    this.messages.push({ role: 'user', content: input.text })
    this.displayMessages.push({
      role: 'user',
      blocks: [{ type: 'text', text: input.text }],
      timestamp: Date.now(),
    })
    yield { type: 'state_changed' }

    // Stream response (may loop for tool calls)
    yield* this._run(executeTool)
  }

  async *retry(executeTool) {
    // Discard partial assistant state from failed attempt
    while (this.messages.at(-1)?.role === 'assistant') this.messages.pop()
    if (this.displayMessages.at(-1) === this._partial) this.displayMessages.pop()
    this._partial = null

    yield* this._run(executeTool)
  }

  async *_run(executeTool) {
    this.controller = new AbortController()
    const { signal } = this.controller

    // Provider-level retry: 3 attempts, short backoff
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(500 * 2 ** attempt)
        if (signal.aborted) return
      }

      try {
        const res = await fetch(this.providerConfig.apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.providerConfig.apiKey}` },
          body: JSON.stringify({
            model: this.providerConfig.modelId,
            system: this.systemPrompt,
            messages: this.messages,
            tools: this.tools,
            stream: true,
          }),
          signal,
        })

        if (!res.ok) {
          const status = res.status
          const body = await res.text().catch(() => '')

          // Non-retryable — throw immediately
          if (status === 401 || status === 403)
            throw new ProviderError(`Auth failed (${status})`, { category: 'auth' })
          if (status === 400 && (body.includes('context') || body.includes('too long')))
            throw new ProviderError(body, { category: 'context_overflow' })
          if (status === 400)
            throw new ProviderError(body || `Bad request`, { category: 'invalid_request' })

          // Retryable — try again at provider level
          lastErr = `Server error (${status})`
          continue
        }

        // Parse streaming response
        const assistantMsg = { role: 'assistant', blocks: [], timestamp: Date.now() }
        this._partial = assistantMsg
        this.displayMessages.push(assistantMsg)

        let toolCalls = []

        for await (const chunk of parseSSE(res)) {
          if (signal.aborted) return

          if (chunk.type === 'text') {
            assistantMsg.blocks.push({ type: 'text', text: chunk.text })
            yield { type: 'text_delta', delta: chunk.text }
          }
          if (chunk.type === 'tool_call') {
            toolCalls.push(chunk)
          }
        }

        // Execute tool calls
        for (const call of toolCalls) {
          yield { type: 'exec_js', id: call.id, description: call.description, code: call.code }
          const result = await executeTool(call)
          this.messages.push({ role: 'assistant', content: call })
          this.messages.push({ role: 'tool', id: call.id, content: result.content })
          yield { type: 'state_changed' }
        }

        // If there were tool calls, loop back for the next response
        if (toolCalls.length > 0) {
          this._partial = null
          yield* this._run(executeTool)
          return
        }

        // Done — commit
        this.messages.push({ role: 'assistant', content: assistantMsg.blocks })
        this._partial = null
        yield { type: 'state_changed' }
        yield { type: 'status_line', text: `${this.providerConfig.modelId}` }
        return

      } catch (err) {
        if (signal.aborted) return
        if (err instanceof ProviderError) throw err  // non-retryable, propagate
        lastErr = err.message
      }
    }

    // Provider retry exhausted — throw for agent-level retry
    throw new ProviderError(lastErr, { category: 'network' })
  }

  abort() {
    this.controller?.abort()
  }

  getDisplayMessages() {
    return this.displayMessages
  }

  getState() {
    return { messages: this.messages, displayMessages: this.displayMessages }
  }

  dispose() {
    this.abort()
  }
}

// --- Registration ---

class ProviderError extends Error {
  constructor(message, { category, retryAfterMs } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.category = category
    this.retryAfterMs = retryAfterMs
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = {
  activate(api) {
    const getConfig = () => ({
      apiUrl: api.getConfig('plugin.my-llm.apiUrl', ''),
      apiKey: api.getConfig('plugin.my-llm.apiKey', ''),
      modelId: api.getConfig('plugin.my-llm.modelId', 'default-model'),
    })

    api.registerProvider({
      id: 'my-llm',
      name: 'My LLM',
      settingsView: 'plugin.my-llm.settings',
      getStatusLine() { return getConfig().modelId },
      createSession(config) { return new MySession(config, getConfig()) },
      restoreSession(config, state) { return new MySession(config, getConfig(), state) },
    })
  }
}
```
