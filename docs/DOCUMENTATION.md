# AgentWFY Documentation

Complete reference documentation for AgentWFY — the local runtime for AI agents.

For an overview and quick start, see the [README](../README.md). For testing and CDP automation, see [TESTING.md](TESTING.md).

---

## Table of Contents

- [Core Concepts](#core-concepts)
  - [What Is an Agent?](#what-is-an-agent)
  - [The execJs Tool](#the-execjs-tool)
  - [System Prompt](#system-prompt)
- [The Chat Interface](#the-chat-interface)
  - [Provider Status Line](#provider-status-line)
  - [Switching Providers](#switching-providers)
- [Sessions](#sessions)
  - [Session Management](#session-management)
  - [Session Persistence](#session-persistence)
  - [Multiple Concurrent Sessions](#multiple-concurrent-sessions)
  - [Context Compaction](#context-compaction)
- [Runtime Functions (execJs)](#runtime-functions-execjs)
  - [File Operations](#file-operations)
  - [SQL & Database](#sql--database)
  - [Tab Management](#tab-management)
  - [Event Bus (Pub/Sub)](#event-bus-pubsub)
  - [Sub-Agents](#sub-agents)
  - [Task Management Functions](#task-management-functions)
  - [Plugin Management Functions](#plugin-management-functions)
  - [Utilities](#utilities)
- [Database System](#database-system)
  - [Docs Table](#docs-table)
  - [Views Table](#views-table)
  - [Tasks Table](#tasks-table)
  - [Triggers Table](#triggers-table)
  - [Config Table](#config-table)
  - [Plugins Table](#plugins-table)
- [Views System](#views-system)
  - [Creating a View](#creating-a-view)
  - [View Runtime API](#view-runtime-api)
  - [CSS Design Tokens](#css-design-tokens)
  - [View Parameters](#view-parameters)
  - [Hidden Tabs for Automation](#hidden-tabs-for-automation)
  - [Tab Features](#tab-features)
- [Tasks & Automation](#tasks--automation)
  - [Creating a Task](#creating-a-task)
  - [Running a Task](#running-a-task)
  - [Task Input](#task-input)
  - [Task Completion Events](#task-completion-events)
  - [Task Panel UI](#task-panel-ui)
- [Triggers](#triggers)
  - [Schedule Triggers (Cron)](#schedule-triggers-cron)
  - [HTTP Triggers](#http-triggers)
  - [Event Triggers](#event-triggers)
  - [Trigger Management](#trigger-management)
- [HTTP API](#http-api)
  - [Built-in Endpoints](#built-in-endpoints)
- [Plugin System](#plugin-system)
  - [Using Plugins](#using-plugins)
  - [Plugin Package Format](#plugin-package-format)
  - [Developing Plugins](#developing-plugins)
  - [Custom LLM Providers via Plugins](#custom-llm-providers-via-plugins)
  - [Publishing Plugins & Agents](#publishing-plugins--agents)
- [Provider System](#provider-system)
  - [Built-in: OpenAI Compatible](#built-in-openai-compatible)
- [Configuration Reference](#configuration-reference)
  - [Global vs Agent Settings](#global-vs-agent-settings)
- [Command Palette](#command-palette)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Releasing](#releasing)

---

## Core Concepts

### What Is an Agent?

An agent is a directory on your file system with a `.agentwfy/agent.db` SQLite database inside `.agentwfy/`. The database holds everything: documentation the agent knows, views it can render, tasks it can run, triggers for automation, configuration, and installed plugins.

**Agents are portable.** Copy the folder (or just the `.agentwfy/` directory) to another machine, open it in AgentWFY, and everything works — sessions, plugins, views, tasks, all of it.

### The execJs Tool

The agent has exactly **one tool**: `execJs`. Every action the agent takes — reading files, running SQL, opening tabs, spawning sub-agents — is JavaScript code executed in an isolated Node.js utility process.

Key constraints:
- **Stateless**: Variables don't persist between execJs calls. Use the database or files for state.
- **Sandboxed**: Code can only access files within the agent's directory. Path traversal is blocked.
- **No browser APIs**: `document`, `window`, `localStorage` are unavailable.
- **No Node.js globals**: `require`, `Buffer`, `module`, `__filename`, `__dirname` are shadowed.
- **Timeout**: Default 5 seconds, configurable up to 120 seconds per call.
- **Output limit**: Results truncated to 50,000 characters / 2,000 lines.

All runtime functions are available as top-level `await`-able calls inside execJs. The code runs in `"use strict"` mode inside an async IIFE.

### System Prompt

The agent's system prompt is automatically constructed from the **docs** table. All docs whose `name` column does **not** contain a dot are preloaded into the prompt. Docs with dots in their names are available on demand but not automatically included.

This means you can shape your agent's personality, knowledge, and behavior by creating docs:

```js
await runSql({
  sql: `INSERT OR REPLACE INTO docs (name, content) VALUES (?, ?)`,
  params: ['my-instructions', 'You are a financial analyst. Always format numbers with 2 decimal places.']
})
```

---

## The Chat Interface

The chat panel is the primary way to interact with your agent. It features:

- **Markdown rendering**: Full markdown support — headings, lists, tables, code blocks, bold/italic, task lists, blockquotes
- **Streaming**: Responses stream in real-time with a typing indicator
- **Thinking blocks**: If your model supports reasoning, thinking blocks are displayed in italic
- **Tool execution cards**: Each `execJs` call appears as an expandable card showing the code, description, and result (including images)
- **File attachments**: Paste large text (500+ chars) and it's automatically treated as an attachment
- **Provider grid**: When starting fresh, available providers are shown as clickable cards
- **Stop button**: Click during streaming to abort the current response
- **Notify on finish**: Click the bell icon to receive a desktop notification when a long-running response completes
- **Input shortcuts**: `Enter` sends, `Shift+Enter` for newlines

### Provider Status Line

The bottom of the chat shows the current provider and model info. When reasoning is enabled, it shows the effort level. After each response, input token count is displayed.

### Switching Providers

Click the settings button in the chat toolbar to open provider settings. If you have multiple providers (via plugins), you can switch between them and set a default.

---

## Sessions

Sessions are individual conversations with the agent. Each session maintains its own message history and provider state.

### Session Management

- **New session**: Click the "+" button or use the chat when no messages are present
- **Switch sessions**: Click on any open session in the session list
- **Session history**: Open the command palette (`Cmd+K`) and navigate to Sessions to see all saved sessions (up to 50 most recent)
- **Close session**: Close the current session to free memory
- **Session labels**: Automatically derived from the first user message (60 chars) or provider-generated title (100 chars)

### Session Persistence

Sessions are automatically saved to `.agentwfy/sessions/` as JSON files. The saved state includes:

```json
{
  "version": 1,
  "sessionId": "uuid",
  "providerId": "openai-compatible",
  "title": "Session title",
  "providerState": { "...provider-specific state..." },
  "updatedAt": 1699564800000
}
```

Sessions are **lazy-loaded**: opening a session from history only loads its messages for display. The full provider session is only created when you send a new message.

### Multiple Concurrent Sessions

You can have multiple sessions active simultaneously. Background sessions can continue streaming while you work in a different session. The status line shows how many agents are currently running.

### Context Compaction

When a conversation approaches the model's token limit, AgentWFY automatically **compacts** the context:

1. Detects `context_length_exceeded` error from the API
2. Summarizes older messages into a structured summary
3. Replaces old messages with the summary
4. Retries the request with the compacted history

This happens transparently — you can have very long conversations without manually managing context.

---

## Runtime Functions (execJs)

These are all the functions available inside `execJs` code blocks. All are async and should be `await`ed.

### File Operations

#### `read({ path, offset?, limit? })`

Read a text file with optional pagination.
- `path` (string): Relative path from agent root
- `offset` (number, optional): Starting line number (1-based)
- `limit` (number, optional): Max lines to read
- Returns: String with content and line info
- Limits: 2,000 lines max, 50KB max per read

```js
const content = await read({ path: 'data/config.json' })
```

#### `write({ path, content })`

Write a text file. Creates parent directories automatically.
- `path` (string): Relative path
- `content` (string): File content
- Returns: Success message with byte count

```js
await write({ path: 'output/report.html', content: '<h1>Report</h1>...' })
```

#### `writeBinary({ path, base64 })`

Write a binary file from base64 data.

#### `readBinary({ path })`

Read a binary file. The file is automatically attached to the response as an image/file.
- Max size: 20MB
- Returns: `{ base64, mimeType, size }`

#### `edit({ path, oldText, newText })`

Surgical text replacement in a file. Requires exact match.
- Errors if text not found or if multiple matches exist

```js
await edit({
  path: 'src/config.js',
  oldText: 'const PORT = 3000',
  newText: 'const PORT = 8080'
})
```

#### `ls({ path?, limit? })`

List directory contents.
- Default limit: 500
- Directories marked with `/` suffix
- `.agentwfy/` is automatically excluded

#### `mkdir({ path, recursive? })`

Create a directory. Recursive by default.

#### `remove({ path, recursive? })`

Delete a file or directory.

#### `find({ pattern, path?, limit? })`

Find files matching a glob pattern.
- Supports `*`, `**`, `?`
- Default limit: 1,000

```js
const files = await find({ pattern: '**/*.json', path: 'data' })
```

#### `grep({ pattern, path?, options? })`

Search file contents with regex.
- `options.ignoreCase`, `options.literal`, `options.context`, `options.limit`
- Default limit: 100

```js
const results = await grep({
  pattern: 'TODO|FIXME',
  path: 'src',
  options: { ignoreCase: true, context: 2, limit: 50 }
})
```

### SQL & Database

#### `runSql({ target?, sql, params?, path?, description? })`

Execute SQL against the agent database or a custom SQLite file.
- `target`: `'agent'` (default) or `'sqlite-file'`
- `params`: Bound parameters (prevents SQL injection)
- Returns: Array of row objects for SELECT; change info for INSERT/UPDATE/DELETE

```js
const docs = await runSql({
  sql: 'SELECT name, content FROM docs WHERE name NOT LIKE "%.%" ORDER BY name'
})

const rows = await runSql({
  target: 'sqlite-file',
  path: 'data/analytics.db',
  sql: 'SELECT * FROM events WHERE date > ?',
  params: ['2025-01-01']
})
```

**Database restrictions:**
- Schema modifications (`CREATE TABLE`, `ALTER`, `DROP`) are blocked
- `system.*` and `plugin.*` docs/views are read-only
- `system.*` and `plugin.*` config cannot be inserted/deleted (only updated)
- The `plugins` table is entirely read-only
- Foreign keys are always enabled

### Tab Management

#### `getTabs()`

Get all open tabs with their state.

#### `openTab({ viewName?, filePath?, url?, title?, hidden?, params? })`

Open a new tab. Exactly **one** of `viewName`, `filePath`, or `url` is required.

```js
await openTab({ viewName: 'system.docs' })
await openTab({ filePath: 'output/dashboard.html', title: 'Dashboard' })
await openTab({ viewName: 'my-report', params: { month: '2025-03' } })

// Hidden tab for automation
const { tabId } = await openTab({ url: 'https://example.com', hidden: true })
const screenshot = await captureTab({ tabId })
await closeTab({ tabId })
```

#### `closeTab({ tabId })`

#### `selectTab({ tabId })`

#### `reloadTab({ tabId })`

#### `captureTab({ tabId })`

Take a screenshot. The image is automatically attached to the agent response.

#### `getTabConsoleLogs({ tabId, since?, limit? })`

Get browser console output from a tab.

#### `execTabJs({ tabId, code, timeoutMs? })`

Execute JavaScript **in the browser context** of a tab. Has access to the DOM.

```js
const title = await execTabJs({
  tabId: 'tab-123',
  code: 'document.querySelector("h1").textContent'
})
```

### Event Bus (Pub/Sub)

#### `publish({ topic, data })`

Publish a message to a topic.
- Messages are **consumed**: each publish delivers to exactly one waiter (FIFO)
- If no waiter exists, the message is queued (up to 1,000 per topic)

#### `waitFor({ topic, timeoutMs? })`

Wait for a message on a topic. Default timeout: 120s.

```js
// Publisher
await publish({ topic: 'data-ready', data: { file: 'report.csv', rows: 1500 } })

// Consumer
const result = await waitFor({ topic: 'data-ready', timeoutMs: 30000 })
```

### Sub-Agents

#### `spawnSession({ prompt })`

Spawn a session with an initial prompt. Runs independently and publishes response to `session:response:{sessionId}`.

```js
const { sessionId } = await spawnSession({ prompt: 'Analyze data/sales.csv and return a JSON summary' })
const response = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 })
```

#### `sendToSession({ sessionId, message })`

Send a follow-up message to a spawned session.

#### `openSessionInChat({ sessionId })`

Open a spawned session in the main chat panel for interactive use.

### Task Management Functions

#### `startTask({ taskId, input? })`

Start a task from the tasks table. Returns `{ runId }`.

#### `stopTask({ runId })`

Stop a running task.

### Plugin Management Functions

#### `requestInstallPlugin({ packagePath })`

Request installation of a plugin package (shows confirmation dialog).

#### `requestTogglePlugin({ pluginName })`

Request enabling/disabling a plugin.

#### `requestUninstallPlugin({ pluginName })`

Request removal of a plugin.

### Utilities

#### `getAvailableFunctions()`

List all registered functions with their sources.

#### `openExternal({ url })`

Open a URL in the user's default browser. Only `http://` and `https://`.

---

## Database System

Every agent has its own SQLite database at `.agentwfy/agent.db` with 6 tables. All tables have `created_at` and `updated_at` columns (Unix epoch seconds). Both are auto-set on INSERT via `DEFAULT (unixepoch())`. The `updated_at` column is automatically bumped on every UPDATE by a SQLite trigger — no need to set it manually.

### Docs Table

| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT (PK) | Document identifier |
| `content` | TEXT | Document content |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds (auto-updated) |

**Name format:** lowercase letters, digits, dots, hyphens, and underscores only (`[a-z0-9._-]`).

**Namespacing:**
- Names **without dots**: Automatically preloaded into the system prompt
- `system.*`: Built-in documentation, **read-only**
- `plugin.*`: Plugin documentation, **read-only**
- Other dotted names: Available on demand but not preloaded

**12 Built-in System Docs:** `system`, `system.views`, `system.config`, `system.plugins`, `system.plugins.dev`, `system.plugins.guide`, `system.tasks`, `system.triggers`, `system.files`, `system.tabs`, `system.eventbus`, `system.sessions`

### Views Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT (UNIQUE) | View identifier |
| `title` | TEXT | Display title |
| `content` | TEXT | HTML/CSS/JS content |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds |

**4 Built-in System Views:** `system.docs`, `system.plugins`, `system.source-explorer`, `system.openai-compatible-provider.settings-view`

### Tasks Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT | Task name |
| `description` | TEXT | Human-readable description |
| `content` | TEXT | JavaScript code to execute |
| `timeout_ms` | INTEGER | Optional timeout (max 120,000ms) |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds |

### Triggers Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `task_id` | INTEGER | References tasks(id), CASCADE delete |
| `type` | TEXT | `'schedule'`, `'http'`, or `'event'` |
| `config` | TEXT | JSON configuration |
| `description` | TEXT | Human-readable description |
| `enabled` | INTEGER | 1 (active) or 0 (disabled) |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds |

### Config Table

| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT (PK) | Setting key |
| `value` | TEXT | String value, or NULL for default |
| `description` | TEXT | Human-readable description |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds (auto-updated) |

**Resolution order:** Agent DB value (non-NULL) → Global config (`~/.agentwfy.json`) → Hardcoded default

### Plugins Table

Read-only for agents.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT (UNIQUE) | Plugin name (lowercase letters, digits, hyphens only — no dots) |
| `title` | TEXT | Optional display title (shown instead of name when set) |
| `description` | TEXT | Plugin description |
| `version` | TEXT | Version string |
| `code` | TEXT | Plugin JavaScript source |
| `author` | TEXT | Author name |
| `repository` | TEXT | Source repository URL |
| `license` | TEXT | License type |
| `enabled` | INTEGER | 1 or 0 |

---

## Views System

Views are HTML pages rendered as tabs. Two types: **database views** (stored in the `views` table) and **file views** (HTML files on disk).

### Creating a View

```js
await runSql({
  sql: `INSERT OR REPLACE INTO views (name, title, content) VALUES (?, ?, ?)`,
  params: ['my-dashboard', 'Sales Dashboard', `
<!DOCTYPE html>
<html>
<head>
  <title>Sales Dashboard</title>
  <style>
    body { font-family: var(--font-family); background: var(--color-bg1); color: var(--color-text3); padding: 20px; }
    .card { background: var(--color-bg2); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 16px; }
  </style>
</head>
<body>
  <h1>Sales Dashboard</h1>
  <div class="card" id="stats"></div>
  <script>
    async function load() {
      const rows = await agentwfy.runSql({
        sql: 'SELECT date, SUM(amount) as total FROM sales GROUP BY date ORDER BY date DESC LIMIT 30'
      })
      document.getElementById('stats').innerHTML = rows.map(r =>
        '<div>' + r.date + ': $' + r.total.toFixed(2) + '</div>'
      ).join('')
    }
    load()
  </script>
</body>
</html>
  `]
})

await openTab({ viewName: 'my-dashboard' })
```

### View Runtime API

Inside views, all runtime functions are available via `window.agentwfy`:

```js
const data = await agentwfy.runSql({ sql: 'SELECT * FROM docs' })
await agentwfy.write({ path: 'export.json', content: JSON.stringify(data) })
await agentwfy.publish({ topic: 'view-action', data: { action: 'refresh' } })
```

### CSS Design Tokens

Views automatically have access to CSS custom properties that match the app's theme:

| Category | Tokens |
|----------|--------|
| **Backgrounds** | `--color-bg1`, `--color-bg2`, `--color-bg3`, `--color-surface` |
| **Text** | `--color-text1` (muted), `--color-text2` (secondary), `--color-text3` (primary), `--color-text4` (strong) |
| **UI** | `--color-border`, `--color-divider`, `--color-accent`, `--color-focus-border` |
| **Semantic** | `--color-red-bg/fg`, `--color-green-bg/fg`, `--color-yellow-bg/fg` |
| **Input** | `--color-input-bg`, `--color-input-border` |
| **Code** | `--color-code-bg` |
| **Typography** | `--font-family`, `--font-mono` |
| **Layout** | `--radius-sm` (4px), `--radius-md` (6px) |
| **Motion** | `--transition-fast` (120ms), `--transition-normal` (200ms) |

### View Parameters

```js
// Open with parameters
await openTab({ viewName: 'invoice-viewer', params: { invoiceId: '42' } })

// Read inside the view
const params = new URLSearchParams(window.location.search)
const invoiceId = params.get('invoiceId')
```

### Hidden Tabs for Automation

```js
const { tabId } = await openTab({ url: 'https://example.com/data', hidden: true })
const data = await execTabJs({ tabId, code: 'document.querySelector(".results").innerText' })
const screenshot = await captureTab({ tabId })
await closeTab({ tabId })
```

### Tab Features

- **Pin/unpin**: Pinned tabs stay on the left with only their icon
- **Drag to reorder**
- **Middle-click to close**
- **Right-click context menu**: Pin, reload, open DevTools
- **Change indicator**: Dot appears when a view's content has been updated
- **Hidden tabs**: Collapsed into a toggle button with count badge

---

## Tasks & Automation

Tasks are reusable JavaScript scripts stored in the database.

### Creating a Task

```js
await runSql({
  sql: `INSERT INTO tasks (title, description, content, timeout_ms) VALUES (?, ?, ?, ?)`,
  params: [
    'daily-report',
    'Generate daily sales report',
    `
      const rows = await runSql({
        sql: 'SELECT product, SUM(amount) as total FROM sales WHERE date = date("now") GROUP BY product'
      })
      const report = rows.map(r => r.product + ': $' + r.total.toFixed(2)).join('\\n')
      await write({ path: '.tmp/daily-report.txt', content: report })
      return { products: rows.length, total: rows.reduce((s, r) => s + r.total, 0) }
    `,
    30000
  ]
})
```

### Running a Task

- **From the agent**: `await startTask({ taskId: 1, input: { date: '2025-03-26' } })`
- **From the command palette**: `Cmd+K` → Tasks → Run
- **From the Task Panel**: Sidebar → Tasks → Run

### Task Input

The `input` parameter is available as a global variable. Sources vary by trigger:
- **Manual/agent**: Whatever is passed to `startTask`
- **HTTP trigger**: `{ method, path, headers, query, body }`
- **Event trigger**: The published event data
- **Schedule trigger**: The `config.input` value

### Task Completion Events

```js
const { runId } = await startTask({ taskId: 1 })
const result = await waitFor({ topic: `task:run:${runId}`, timeoutMs: 60000 })
```

### Task Panel UI

Three tabs: **Runs** (live + history), **Tasks** (definitions + Run buttons), **Triggers** (enable/disable toggles).

---

## Triggers

### Schedule Triggers (Cron)

6-field cron: `second minute hour day month weekday`

| Field | Range |
|-------|-------|
| second | 0-59 |
| minute | 0-59 |
| hour | 0-23 |
| day | 1-31 |
| month | 1-12 |
| weekday | 0-6 (0=Sun) |

Examples:
- `0 */5 * * * *` — Every 5 minutes
- `0 0 9 * * 1-5` — 9:00 AM, weekdays
- `*/30 * * * * *` — Every 30 seconds

```js
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'schedule', ?, ?)`,
  params: [taskId, JSON.stringify({ expression: '0 0 3 * * *' }), 'Run at 3 AM daily']
})
```

### HTTP Triggers

Expose tasks as REST endpoints on the local HTTP API.

```js
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'http', ?, ?)`,
  params: [taskId, JSON.stringify({ path: '/webhook', method: 'POST' }), 'Webhook endpoint']
})
```

Now `POST http://localhost:9877/webhook` triggers the task.

**Response format:**
- Success: `{ "ok": true, "data": <return value> }`
- Timeout: `{ "ok": false, "error": "Task execution timeout" }` (504)
- Error: `{ "ok": false, "error": "<message>" }` (500)

### Event Triggers

React to event bus messages, including file system changes.

**File watcher pattern:** `file:<event>:<directory>`

| Event | Fires When |
|-------|-----------|
| `file:created:<dir>` | New file created |
| `file:deleted:<dir>` | File deleted |
| `file:changed:<dir>` | File modified |

```js
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'event', ?, ?)`,
  params: [taskId, JSON.stringify({ topic: 'file:created:uploads' }), 'Process new uploads']
})
```

Task receives: `{ event: 'created', filename: 'report.csv', path: 'uploads/report.csv' }`

Notes: Non-recursive, debounced at 200ms, directory auto-created if missing.

### Trigger Management

Triggers auto-reload on DB changes. Enable/disable without deleting:

```js
await runSql({ sql: 'UPDATE triggers SET enabled = 0 WHERE id = ?', params: [triggerId] })
```

---

## HTTP API

Local HTTP server for external integrations.

- **Default port:** 9877 (configurable in settings)
- **CORS:** Enabled for all origins
- **Max body size:** 10 MB
- **Lockfile:** `.agentwfy/http-api.pid` → `{ "port": 9877, "pid": 12345 }`

### Built-in Endpoints

#### `GET /files/{relative_path}`

Serve files from the agent directory with correct MIME types.

```bash
curl http://localhost:9877/files/data/report.json
```

#### Dynamic Endpoints

Any HTTP trigger creates a corresponding REST endpoint.

---

## Plugin System

### Using Plugins

**Installing:**
1. Command palette (`Cmd+K`) → Install Plugin → choose `.plugins.awfy` file
2. Or via agent: `await requestInstallPlugin({ packagePath: '/path/to/plugin.plugins.awfy' })`

**Managing:** Command palette → Plugins, or open `system.plugins` view. Toggle on/off or uninstall.

### Plugin Package Format

A `.plugins.awfy` file is a SQLite database:

| Table | Purpose |
|-------|---------|
| `plugins` | Code and metadata (1+ rows) |
| `docs` | Documentation (0+ rows) |
| `views` | HTML views (0+ rows) |
| `config` | Default settings (0+ rows) |
| `assets` | Binary files (0+ rows) |

### Developing Plugins

#### Entry Point

```js
module.exports = {
  activate(api) {
    // Register functions, providers, etc.

    return {
      deactivate() { /* cleanup long-running resources */ }
    }
  }
}
```

#### Plugin API

| Method | Description |
|--------|-------------|
| `api.agentRoot` | Absolute path to agent's data directory |
| `api.assetsDir` | Path to plugin assets |
| `api.registerFunction(name, handler)` | Register a callable function |
| `api.registerProvider(factory)` | Register a custom LLM provider |
| `api.publish(topic, data)` | Publish to event bus |
| `api.getConfig(name, fallback?)` | Read config value |
| `api.setConfig(name, value)` | Write config value |

#### Registering Functions

```js
api.registerFunction('myPluginTransform', async (params) => {
  // Full Node.js access: require('fs'), require('child_process'), etc.
  return { transformed: result, timestamp: Date.now() }
})
```

Functions run in the **main Electron process** with full `require()` access.

### Custom LLM Providers via Plugins

#### Provider Factory

```js
api.registerProvider({
  id: 'my-llm',
  name: 'My Custom LLM',
  settingsView: 'plugin.my-llm.settings',     // optional: view for settings UI
  getStatusLine() { return 'model-name' },     // optional: status shown in chat UI
  createSession(config) { return new MySession(config) },
  restoreSession(config, state) { return new MySession(config, state) },
})
```

`config` includes `sessionId`, `systemPrompt`, and `tools`.

#### Provider Session Interface

Sessions are async iterators that drive the full streaming lifecycle. They must implement:

- `async *stream(input, executeTool)` — Stream a user turn. `input` is `{ text, files? }`. `executeTool` is a callback for tool calls. Returns an async iterable of events.
- `async *retry(executeTool)` — Retry the last failed turn. Discards partial state from the failed attempt and re-calls the API.
- `abort()` — Cancel the current stream. The iterator should complete normally (not throw).
- `getDisplayMessages()` — Return display messages for UI (always sync).
- `getState()` — Return serializable state for session persistence.
- `dispose()` — Clean up resources (timers, connections, abort controllers).
- `getTitle()` — Optional. Return a session title.

**Stream events:**

| Event | Description |
|-------|-------------|
| `{ type: 'text_delta', delta }` | Incremental text content |
| `{ type: 'thinking_delta', delta }` | Incremental reasoning content |
| `{ type: 'exec_js', id, description, code }` | Tool call (yield before calling `executeTool`) |
| `{ type: 'status_line', text }` | Status update / keepalive |
| `{ type: 'state_changed' }` | Triggers session persistence to disk |

No `start`, `done`, or `error` events. Iterator completion = done. Errors are thrown with a `category` property.

**Tool execution:** When the model requests a tool call, yield an `exec_js` event for UI display, then call `const result = await executeTool({ id, description, code })`. The result has `{ content, isError }`.

**Error categories:**

| Category | Agent Action |
|---|---|
| `network`, `rate_limit`, `server` | Retry with exponential backoff (up to 10 attempts) |
| `auth`, `invalid_request`, `content_policy` | Stop, show error to user |
| `context_overflow` | Compact old messages, then retry |

Providers should do their own fast retry (2-3 attempts) for transient HTTP errors before throwing. The agent's retry is a second tier for sustained outages.

**Idle timeout:** The agent runs a 90-second watchdog during streaming. If no event is yielded for 90s (and no tool execution is active), it treats it as a dead connection and retries. Yield `status_line` events periodically to prevent false timeouts during long server-side processing.

### Publishing Plugins & Agents

#### Plugin Registry

Registry: [github.com/AgentWFY/plugins](https://github.com/AgentWFY/plugins)

1. Build your `.plugins.awfy` package
2. Upload as a GitHub Release asset
3. Open an issue in AgentWFY/plugins using the **Publish Plugin** template
4. Maintainer reviews and adds `approved` label
5. GitHub Actions validates and adds to registry

**Requirements:** One plugin per package. Plugin names must contain only lowercase letters, digits, and hyphens (`[a-z0-9-]`). Required fields: `name`, `description`, `version`, `author`, `license`. Accepted licenses: MIT, Apache-2.0, GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, BSD-2-Clause, BSD-3-Clause, MPL-2.0, ISC, Unlicense, CC0-1.0.

#### Agent Registry

Registry: [github.com/AgentWFY/agents](https://github.com/AgentWFY/agents)

An `.agent.awfy` file must contain at least `views` and `docs` tables. Upload, open issue, get approved.

---

## Provider System

### Built-in: OpenAI Compatible

Provider settings are defined in `src/system-config/system-config.json`.

**Reasoning/Thinking:** When enabled, sends `reasoning.effort` parameter and displays thinking blocks.

**Retry Logic:** Auto-retries on 408, 429, 5xx with exponential backoff (up to 2 retries). Respects `retry-after` headers.

---

## Configuration Reference

All settings stored in the `config` table. See `src/system-config/system-config.json` for the full list of system settings and their descriptions.

### Global vs Agent Settings

- **Global**: Apply to all agents, stored in `~/.agentwfy.json`
- **Agent**: Override globals (stored in `agent.db`)
- Setting to `NULL` falls back to global

The global config file is a plain JSON file that can be edited by hand. If `~/.agentwfy.json` does not exist, the app falls back to the internal Electron store.

---

## Command Palette

`Cmd+K` / `Ctrl+K` provides quick access to:

- **Views**: Open any system, plugin, or user view
- **Agents**: Open or install agents
- **Plugins**: Install, enable/disable, uninstall
- **Tasks**: Run tasks with optional input
- **Sessions**: Browse and restore history
- **Settings**: View and modify configuration
- **Backups**: List and restore database backups

---

## Keyboard Shortcuts

Keyboard shortcuts are configurable via `system.shortcuts.*` config keys. Set a shortcut to `'disabled'` to unbind it. Defaults can be viewed in the Settings screen (`Cmd+,` / `Ctrl+,`).

---

## Releasing

```bash
npm version patch   # or minor / major
git push origin master --tags
```

GitHub Actions builds for all platforms and creates a **draft release**. Edit the draft, add notes, publish. Running apps detect updates within 4 hours.
