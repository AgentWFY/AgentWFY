# system.plugins.dev

Plugin development guide. Plugins extend the agent runtime with new functions and LLM providers, backed by Node.js code running in the main process.

## Plugin Code

Export an `activate` function that receives a `PluginApi` object. Use `api.registerFunction()` to expose functions and `api.registerProvider()` to register LLM providers.

```js
module.exports = {
  activate(api) {
    const root = api.agentRoot
    const assets = api.assetsDir

    api.registerFunction('myPluginDo', async (params) => {
      // params — whatever the agent passes when calling myPluginDo(params)
      // root, assets — captured during activation
      // api.publish(topic, data) — post to the event bus
      return { result: 'done' }
    })
  }
}
```

### Deactivation

`activate()` can optionally return `{ deactivate }`. Called when the window closes — use it to clean up long-running resources (child processes, timers, connections).

```js
module.exports = {
  activate(api) {
    const processes = new Map()

    api.registerFunction('start', async (params) => {
      const child = spawn(...)
      processes.set(child.pid, child)
      return { pid: child.pid }
    })

    return {
      deactivate() {
        for (const child of processes.values()) child.kill('SIGTERM')
        processes.clear()
      }
    }
  }
}
```

### api object

- `api.agentRoot` — absolute path to the agent's data directory.
- `api.assetsDir` — path to `.agentwfy/plugin-assets/<name>/` for runtime files (binaries, caches).
- `api.publish(topic, data)` — publish a message to the event bus.
- `api.registerFunction(name, handler)` — register a function. `name` becomes the global function name in execJs / views.
- `api.registerProvider(factory)` — register an LLM provider. See [Provider Plugins](#provider-plugins).
- `api.getConfig(name, fallback?)` — read a config value from the agent's config table. Returns the parsed JSON value, or `fallback` if not set. Use this for reading plugin config (e.g. `api.getConfig('plugin.my-provider.apiKey', '')`).
- `api.setConfig(name, value)` — write a config value to the agent's config table. The value is JSON-serialized. Use this for persisting plugin state from the main process (e.g. refreshed OAuth tokens).

### handler signature

```
handler(params: unknown) → Promise<unknown>
```

- `params` — the argument the agent passes when calling the function.

The handler runs in the main process with full Node.js access (child_process, fs, net, etc.). Return values are serialized back to the worker/view via IPC — return JSON-serializable data only.

### Naming rules

- Function names must not collide with built-in runtime functions (`runSql`, `read`, `write`, `openTab`, `fetch`, etc.) or functions from other plugins. Collisions are logged as warnings and the function is skipped.
- Use a plugin-specific prefix to avoid collisions: `myPluginDo`, `myPluginQuery`, etc.
- Provider IDs must be unique. A plugin cannot override the built-in `openai-compatible` provider or another plugin's provider.

## Provider Plugins

Plugins can register LLM providers that appear alongside the built-in OpenAI-compatible provider. A provider owns the full streaming lifecycle: conversation state, API requests, message format, compaction, and auth.

### Registering a provider

```js
module.exports = {
  activate(api) {
    api.registerProvider({
      id: 'my-provider',
      name: 'My Provider',

      // Optional: name of a view in the views table that renders provider settings.
      // The settings gear icon in the provider picker opens this view.
      settingsView: 'plugin.my-provider.settings',

      // Optional: returns a status line string shown in the chat UI
      // (model name, thinking level, context size, etc.)
      getStatusLine() {
        return 'my-model · high'
      },

      createSession(config) {
        // config.sessionId — unique session ID
        // config.systemPrompt — system prompt loaded from docs table
        // Return a ProviderSession object (see below)
        return new MySession(config)
      },

      restoreSession(config, state) {
        // config — same as createSession
        // state — opaque blob from getState() (null for new sessions)
        // Use state to restore internal messages and display messages.
        return new MySession(config, state)
      },
    })
  }
}
```

### ProviderSession interface

The session object returned by `createSession` / `restoreSession` must implement:

```js
class MySession {
  // Stream a user message. Returns an async iterable of events.
  // executeTool is a callback — call it and await the result when the model requests a tool.
  // providerOptions is an optional Record<string, unknown> from spawnSession.
  async *stream(input, executeTool, providerOptions) {
    // input = { text: string, files?: FileContent[] }
    // executeTool = async ({ id, description, code }) => { content: [...], isError: boolean }

    // Add user message to internal state, then stream response:
    yield { type: 'text_delta', delta: '...' }
    yield { type: 'thinking_delta', delta: '...' }

    // When a tool call is needed:
    yield { type: 'exec_js', id: '...', description: '...', code: '...' }
    const result = await executeTool({ id, description, code })
    // Process result, continue streaming...

    yield { type: 'state_changed' }
    // Iterator completion = turn done. No 'done' event needed.
  }

  // Retry after a failed stream. Discard partial state from failed attempt, re-call API.
  async *retry(executeTool) {
    this._discardPartialState()
    yield* this._doStream(executeTool)
  }

  // Cancel the current stream. Iterator should complete (not throw).
  abort() { this.abortController?.abort() }

  // Return display messages (always sync).
  getDisplayMessages() { return this.displayMessages.slice() }

  // Optional: return a session title.
  // getTitle() { return this._title }

  // Return serializable state for persistence.
  getState() { return { messages: this.apiMessages, displayMessages: this.displayMessages } }

  // Clean up resources (timers, connections).
  dispose() { this.abort() }
}
```

### Stream events

The async generator yields these event types:

- `{ type: 'text_delta', delta }` — incremental text content
- `{ type: 'thinking_delta', delta }` — incremental thinking/reasoning content
- `{ type: 'exec_js', id, description, code }` — tool call (for UI display, before calling executeTool)
- `{ type: 'status_line', text }` — model info display (model name, token counts, etc.)
- `{ type: 'state_changed' }` — internal state committed (triggers session persistence)

No `start`, `done`, or `error` events. Iterator completion = done. Errors are thrown.

### Error handling

Throw errors with a `category` property to enable smart retry behavior:

```js
const error = new Error('API rate limited')
error.category = 'rate_limit'      // agent retries with backoff
error.retryAfterMs = 30000         // optional: hint for retry delay
throw error
```

Categories:
- `network` — connection failed, DNS error, timeout (agent retries)
- `rate_limit` — 429 Too Many Requests (agent retries, respects retryAfterMs)
- `server` — 500+ server error (agent retries)
- `auth` — 401/403 authentication error (agent stops, shows error)
- `invalid_request` — 400 bad request (agent stops, shows error)
- `content_policy` — content blocked (agent stops, shows error)
- `context_overflow` — context too long (agent stops, shows error)

Retryable errors (`network`, `rate_limit`, `server`) are automatically retried by the agent core — up to 10 attempts with exponential backoff (5s to 5min). The UI shows a retry countdown banner. Fatal errors stop immediately.

Providers should keep their own fast retry for transient HTTP errors (2-3 attempts, short backoff). Throw only after internal retry is exhausted.

### Event flow

```
agent calls session.stream({ text: '...' }, executeTool, providerOptions?)
  provider yields 'text_delta'        (repeated)
  provider yields 'exec_js'           (0 or more tool calls)
  provider awaits executeTool(call)    (agent executes, returns result)
  provider yields 'text_delta'        (continued response)
  provider yields 'state_changed'
  iterator completes                  (done)
```

The provider drives the tool loop internally — after receiving tool results via the callback, it makes the next API call within the same generator.

### Abort

When `abort()` is called, the provider should cancel in-flight requests and return from the generator. Do not throw — iterator completion after abort is not a failure.

### Idle timeout

The agent core imposes a 90-second idle timeout. If no event is yielded for 90 seconds, the agent treats it as a dead connection and retries. To prevent false timeouts during long model thinking, yield `status_line` events periodically.

### Incremental session persistence

Yield `{ type: 'state_changed' }` after committing a meaningful state change — user message added, assistant response committed, or tool result received. The core persists the session to disk on each `state_changed` event. Do not yield `state_changed` while a tool call is pending.

### Status line

Yield `{ type: 'status_line', text }` to update the model info display. Also serves as a keepalive to prevent false idle timeouts. Typical content: model name, thinking/reasoning level, context token count.

Also implement `getStatusLine()` on the factory to provide a status line before any session exists.

### DisplayMessage format

`getDisplayMessages()` returns an array of display messages used for session persistence and UI rendering:

```js
{
  role: 'user' | 'assistant',
  blocks: [
    { type: 'text', text: '...' },
    { type: 'thinking', text: '...' },
    { type: 'file', mimeType: '...', data: '<base64>' },
    { type: 'exec_js', id: '...', code: '...' },
    { type: 'exec_js_result', id: '...', content: [...], isError: false },
  ],
  timestamp: 1234567890
}
```

### Provider config

The active provider is stored in the `system.provider` config name.

Plugin providers can store their configuration in the `config` table under plugin config keys (e.g. `plugin.<name>.apiKey`, `plugin.<name>.modelId`). Read config via `api.getConfig(name, fallback)` — this uses the app's shared DB connection. Config rows from the plugin package are synced on install, so defaults can be set in the package's `config` table.

### Provider settings view

Set `settingsView` to the name of a view in the views table. The chat UI shows a gear icon next to the provider name in the provider picker — clicking it opens this view as a tab. Use this to build custom auth flows (OAuth), model pickers, or any provider-specific configuration UI.

### Example: Custom Provider

```js
class MySession {
  constructor(config, providerConfig, restored) {
    this.config = config
    this.providerConfig = providerConfig
    this.messages = restored?.messages || []
    this.displayMessages = restored?.displayMessages || []
    this.controller = null
  }

  async *stream(input, executeTool, providerOptions) {
    this.messages.push({ role: 'user', content: input.text })
    this.displayMessages.push({ role: 'user', blocks: [{ type: 'text', text: input.text }], timestamp: Date.now() })
    yield { type: 'state_changed' }
    yield* this._run(executeTool)
  }

  async *retry(executeTool) {
    while (this.messages.at(-1)?.role === 'assistant') this.messages.pop()
    yield* this._run(executeTool)
  }

  async *_run(executeTool) {
    this.controller = new AbortController()
    const modelId = this.providerConfig.modelId
    try {
      const res = await fetch(this.providerConfig.apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.providerConfig.apiKey}` },
        body: JSON.stringify({ model: modelId, messages: this.messages, stream: true }),
        signal: this.controller.signal,
      })
      if (!res.ok) {
        const err = new Error(`API error (${res.status})`)
        err.category = res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : 'invalid_request'
        throw err
      }
      // ... parse SSE, yield text_delta events ...
      // When tool calls are needed:
      //   yield { type: 'exec_js', id, description, code }
      //   const result = await executeTool({ id, description, code })
      //   // process result, yield* this._run(executeTool) to continue
      yield { type: 'state_changed' }
    } catch (err) {
      if (this.controller.signal.aborted) return  // abort = clean exit
      if (err.category) throw err  // classified error — propagate
      const e = new Error(err.message); e.category = 'network'; throw e
    }
  }

  abort() { this.controller?.abort() }
  dispose() { this.abort() }
  getDisplayMessages() { return this.displayMessages.slice() }
  getState() { return { messages: this.messages, displayMessages: this.displayMessages } }
}

module.exports = {
  activate(api) {
    const getConfig = () => ({
      apiUrl: api.getConfig('plugin.my-llm.apiUrl', ''),
      apiKey: api.getConfig('plugin.my-llm.apiKey', ''),
      modelId: api.getConfig('plugin.my-llm.modelId', 'my-model-v2'),
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

## Plugin Package Format

Plugins are distributed as `.plugins.awfy` files (SQLite databases) with these tables:

```sql
plugins (name TEXT, title TEXT, description TEXT, version TEXT, code TEXT, author TEXT, repository TEXT, license TEXT) — 1..N rows (required)
docs    (name TEXT, content TEXT)                                      — 0..N rows (optional)
views   (name TEXT, title TEXT, content TEXT)                          — 0..N rows (optional)
config  (name TEXT, value TEXT, description TEXT)                      — 0..N rows (optional)
assets  (name TEXT, data BLOB)                                        — 0..N rows (optional)
```

The `author`, `repository`, and `license` columns are optional for local plugins. They are required when publishing to the public plugin registry.

A package can contain one or multiple plugins (plugin pack).

### Naming conventions

- **plugins**: names must match `[a-z0-9-]+` (no dots — dots are namespace separators).
- **docs**: must start with `plugin.<name>` where `<name>` matches a plugin in the `plugins` table. Example: `plugin.ffmpeg`, `plugin.ffmpeg.usage`. Names must match `[a-z0-9._-]+`.
- **views**: must start with `plugin.<name>`. Example: `plugin.my-llm.settings`. Views are synced to the agent's `views` table on install and can be opened as tabs.
- **config**: must start with `plugin.<name>`. Example: `plugin.my-llm.apiKey`. Config rows are synced to the agent's `config` table on install. Use `value` for default values or `NULL` for unset.
- **assets**: must use `<name>/<filename>` format. Example: `ffmpeg/ffmpeg-darwin-arm64`. Extracted to `.agentwfy/plugin-assets/<name>/<filename>` on install.

### Welcome view

If a plugin package includes a view named `plugin.<name>.welcome`, it is automatically opened as a tab after installation. Use this for onboarding — API key setup, getting started instructions, or first-run configuration.

## Plugin Docs

Include docs in the package's `docs` table. They are synced to agent.db on install:

- `plugin.<name>` — main doc for the plugin
- `plugin.<name>.<section>` — additional sections

Plugin docs are read-only from the agent's perspective. The `system.plugins` doc auto-lists all installed plugins and tells the agent to load `plugin.<name>` for details. Use docs to document function signatures, parameters, return values, and usage examples so the agent knows how to call your functions.

## Error Handling

- If plugin code fails to eval or doesn't export `activate`, the plugin is skipped with a warning.
- If a function handler throws, the error is propagated as a rejected promise to the caller — the app does not crash.
- If `registerProvider` is called with an ID that's already registered, it is skipped with a warning.
- Package validation rejects invalid packages entirely — no partial installs.


This table is read-only from SQL — the agent can query it but cannot modify it.
