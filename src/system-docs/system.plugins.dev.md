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
  send(event) {
    // event.type is one of:
    //   'user_message' — { text, images? } — user sent a message
    //   'exec_js_result' — { id, content, isError } — tool execution completed
    //   'abort' — user pressed stop
  }

  on(listener) {
    // Register a listener for output events.
    // The listener receives objects with these types:
    //   { type: 'start' }
    //   { type: 'text_delta', delta: string }
    //   { type: 'thinking_delta', delta: string }
    //   { type: 'exec_js', id: string, description: string, code: string }
    //   { type: 'done' }
    //   { type: 'error', error: string }
    //   { type: 'status_line', text: string }
    //   { type: 'state_changed' }
  }

  off(listener) {
    // Remove a previously registered listener.
  }

  getDisplayMessages() {
    // Return DisplayMessage[] — the conversation as shown in the UI.
    // The provider controls what is displayed: it can filter thinking
    // blocks, hide intermediate tool calls, etc. based on config.
    // Called after each completed turn and when restoring a session.
  }

  // Optional: return a short string for the session list (max ~100 chars).
  // If not implemented, falls back to first user message text.
  // Providers can override to summarize or generate titles.
  // getTitle() { return 'My custom title' }

  getState() {
    // Return an opaque JSON-serializable blob with all provider state.
    // Must include both internal API messages and full (unfiltered)
    // display messages. Passed back to restoreSession() on restore.
    return { messages: this.internalMessages, displayMessages: this.displayMessages }
  }
}
```

### Event flow

```
User types message
  → core sends { type: 'user_message', text, images? }
  → provider streams response via listener:
      { type: 'start' }
      { type: 'text_delta', delta } (repeated)
      { type: 'exec_js', id, description, code }
  → core executes the tool, then sends result:
      { type: 'exec_js_result', id, content, isError }
  → provider continues streaming (or emits done):
      { type: 'done' }
```

The provider decides when to call the LLM again after receiving tool results — the core does not drive the loop.

### Incremental session persistence

Emit `{ type: 'state_changed' }` after committing a meaningful state change — user message added, assistant response committed, or tool result received. The core persists the session to disk on each `state_changed` event, so progress is saved incrementally. Without this, session data is only saved when the full turn completes (`done`), and closing the app mid-session loses all progress.

### Status line

Emit `{ type: 'status_line', text }` at any point to update the model info display in the chat UI. Typical content: model name, thinking/reasoning level, context token count. Emit on `start` and after each stream completion when usage data is available.

Also implement `getStatusLine()` on the factory to provide a status line before any session exists (shown on empty sessions in the chat UI).

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
const { parseSSE } = require('./sse')  // can require built-in modules

class MySession {
  constructor(config, existingMessages) {
    this.systemPrompt = config.systemPrompt
    this.messages = existingMessages || []
    this.listeners = new Set()
  }

  send(event) {
    if (event.type === 'user_message') {
      this.messages.push({ role: 'user', blocks: [{ type: 'text', text: event.text }], timestamp: Date.now() })
      this.emit({ type: 'state_changed' })
      this.stream(event.text)
    } else if (event.type === 'exec_js_result') {
      // append result, continue streaming
      this.emit({ type: 'state_changed' })
    } else if (event.type === 'abort') {
      this.abortController?.abort()
    }
  }

  on(listener) { this.listeners.add(listener) }
  off(listener) { this.listeners.delete(listener) }
  getDisplayMessages() { return this.messages }
  getState() { return { messages: this.internalMessages, displayMessages: this.messages } }

  emit(event) {
    for (const l of this.listeners) l(event)
  }

  async stream(userText) {
    this.emit({ type: 'start' })
    // ... fetch from your API, parse SSE, emit deltas ...
    // commit assistant message to this.messages here
    this.emit({ type: 'state_changed' })
    this.emit({ type: 'done' })
  }
}

module.exports = {
  activate(api) {
    function getProviderConfig() {
      return {
        apiKey: api.getConfig('plugin.my-llm.apiKey', ''),
        modelId: api.getConfig('plugin.my-llm.modelId', 'my-model-v2'),
      }
    }

    api.registerProvider({
      id: 'my-llm',
      name: 'My LLM',
      settingsView: 'plugin.my-llm.settings',
      getStatusLine() { return getProviderConfig().modelId },
      createSession(config) { return new MySession(config, getProviderConfig()) },
      restoreSession(config, state) { return new MySession(config, getProviderConfig(), state) },
    })
  }
}
```

## Plugin Package Format

Plugins are distributed as `.plugins.awfy` files (SQLite databases) with these tables:

```sql
plugins (name TEXT, description TEXT, version TEXT, code TEXT, author TEXT, repository TEXT, license TEXT) — 1..N rows (required)
docs    (name TEXT, content TEXT)                                      — 0..N rows (optional)
views   (name TEXT, title TEXT, content TEXT)                          — 0..N rows (optional)
config  (name TEXT, value TEXT, description TEXT)                      — 0..N rows (optional)
assets  (name TEXT, data BLOB)                                        — 0..N rows (optional)
```

The `author`, `repository`, and `license` columns are optional for local plugins. They are required when publishing to the public plugin registry.

A package can contain one or multiple plugins (plugin pack).

### Naming conventions

- **docs**: must start with `plugin.<name>` where `<name>` matches a plugin in the `plugins` table. Example: `plugin.ffmpeg`, `plugin.ffmpeg.usage`.
- **views**: must start with `plugin.<name>`. Example: `plugin.my-llm.settings`. Views are synced to the agent's `views` table on install and can be opened as tabs.
- **config**: must start with `plugin.<name>`. Example: `plugin.my-llm.apiKey`. Config rows are synced to the agent's `config` table on install. Use `value` for default values or `NULL` for unset.
- **assets**: must use `<name>/<filename>` format. Example: `ffmpeg/ffmpeg-darwin-arm64`. Extracted to `.agentwfy/plugin-assets/<name>/<filename>` on install.

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

## Database

The `plugins` table:

```sql
plugins (id, name UNIQUE, description, version, code TEXT, author, repository, license, enabled, created_at, updated_at)
```

The `author`, `repository`, and `license` columns are nullable — they are populated when a plugin is installed from a package that includes them.

This table is read-only from SQL — the agent can query it but cannot modify it.
