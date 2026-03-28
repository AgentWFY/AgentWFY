<p align="center">
  <img src="icons/icon.png" width="128" height="128" alt="AgentWFY">
</p>

<h1 align="center">AgentWFY</h1>

<p align="center"><strong>A local runtime for AI agents.</strong></p>

<p align="center">
  <a href="https://github.com/AgentWFY/AgentWFY/releases/latest"><img src="https://img.shields.io/github/v/release/AgentWFY/AgentWFY" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform: macOS">
  <a href="https://github.com/AgentWFY/AgentWFY/stargazers"><img src="https://img.shields.io/github/stars/AgentWFY/AgentWFY" alt="Stars"></a>
</p>

<p align="center">
AgentWFY is an open-source desktop app that gives AI agents a real runtime on your machine. Each agent gets its own SQLite database, file system access, JavaScript execution, browser control, and automation triggers.
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/c3ff490b-bbc7-41a1-9807-2823c09d0624" width="720" autoplay loop muted playsinline></video>
</p>

## Features

| Feature | Description |
|---------|-------------|
| **Code Execution** | Agents run JavaScript in sandboxed Node.js utility processes |
| **SQLite Per Agent** | Every agent has its own portable database — copy, share, back up |
| **File System** | Read, write, search, and organize files within the agent's sandbox |
| **Browser Control** | Open tabs, capture screenshots, execute DOM JavaScript |
| **Triggers** | Cron schedules, HTTP webhooks, file watchers, event bus |
| **Plugin System** | Extend with plugins — custom functions, LLM providers, views, and config |
| **Multi-Provider** | OpenRouter, Ollama, DeepSeek, Groq, LM Studio, or any OpenAI-compatible API |
| **Sub-Agents** | Spawn child agents for parallel, multi-agent workflows via pub/sub |
| **HTML Views** | Agents create live dashboards, charts, forms, and custom interfaces |
| **HTTP API** | Local REST endpoints for external integrations and automations |
| **Context Compaction** | Automatic conversation summarization for very long sessions |
| **Private by Default** | Your data stays on your machine — no telemetry, no cloud dependency |

---

## Table of Contents

- [Getting Started](#getting-started)
- [Core Concepts](#core-concepts)
- [The Chat Interface](#the-chat-interface)
- [Sessions](#sessions)
- [Runtime Functions (execJs)](#runtime-functions-execjs)
- [Database System](#database-system)
- [Views System](#views-system)
- [Tasks & Automation](#tasks--automation)
- [Triggers](#triggers)
- [HTTP API](#http-api)
- [Plugin System](#plugin-system)
- [Publishing Plugins & Agents](#publishing-plugins--agents)
- [Provider System](#provider-system)
- [Configuration Reference](#configuration-reference)
- [Command Palette](#command-palette)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Creative Use Cases & Recipes](#creative-use-cases--recipes)
- [Tech Stack](#tech-stack)
- [Releasing](#releasing)
- [Contributing](#contributing)
- [License](#license)

---

## Getting Started

### Installation

```bash
git clone https://github.com/agentWFY/agentWFY.git
cd agentWFY
./scripts/setup
./scripts/build
./scripts/start
```

### First Launch

On first launch, you'll see a welcome screen asking you to pick or create a directory for your agent. This directory becomes the agent's workspace — everything the agent creates, reads, and stores lives here.

Inside the directory, AgentWFY creates a hidden `.agentwfy/` folder containing:

```
your-agent-folder/
  .agentwfy/
    agent.db            # SQLite database (docs, views, tasks, triggers, config, plugins)
    sessions/           # Persisted conversation sessions
    task_logs/          # Task execution logs
    plugin-assets/      # Plugin binary assets
    backups/            # Automatic database backups
    http-api.pid        # HTTP API lockfile (port + PID)
```

### Connecting an LLM Provider

Before chatting, you need to configure an LLM provider:

1. Click the **settings icon** in the chat panel, or open `system.settings` from the command palette (`Cmd+K` / `Ctrl+K`)
2. Enter your **API Key** (e.g., an OpenRouter API key)
3. Set the **Model ID** (default: `deepseek/deepseek-v3.2`)
4. Optionally change the **Base URL** (default: `https://openrouter.ai/api`)

The built-in provider works with any OpenAI-compatible API: OpenRouter, DeepSeek, Groq, local models via Ollama/LM Studio, or any other endpoint that implements the `/v1/chat/completions` streaming format.

### Your First Conversation

Type a message in the chat input and press Enter. The agent will respond and can execute JavaScript code via its `execJs` tool to interact with your files, database, tabs, and more. Everything the agent does is visible in the chat as expandable code blocks showing what was executed and what it returned.

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

The agent's system prompt is automatically constructed from the **docs** table. All docs whose `name` column does **not** contain a dot (e.g., `getting-started`, `my-knowledge-base`) are preloaded into the prompt. Docs with dots in their names (e.g., `system.views`, `reference.api`) are available on demand but not automatically included.

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

- **Markdown rendering**: Agent responses render with full markdown support — headings, lists, tables, code blocks, bold/italic, task lists, blockquotes
- **Streaming**: Responses stream in real-time with a typing indicator
- **Thinking blocks**: If your model supports reasoning (e.g., with `reasoning` set to `high`), thinking blocks are displayed in italic
- **Tool execution cards**: Each `execJs` call appears as an expandable card showing the code, description, and result (including images)
- **File attachments**: Paste large text (500+ chars) and it's automatically treated as an attachment
- **Provider grid**: When starting fresh (no messages), available providers are shown as clickable cards
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

Sessions are **lazy-loaded**: opening a session from history only loads its messages for display. The full provider session (with internal message history) is only created when you send a new message.

### Multiple Concurrent Sessions

You can have multiple sessions active simultaneously. Background sessions can continue streaming while you work in a different session. The status line shows how many agents are currently running.

### Context Compaction

When a conversation approaches the model's token limit, AgentWFY automatically **compacts** the context:

1. Detects `context_length_exceeded` error from the API
2. Summarizes older messages into a structured summary (Goal, Progress, Key Decisions, Next Steps, Critical Context)
3. Replaces old messages with the summary
4. Retries the request with the compacted history

This happens transparently — you can have very long conversations without manually managing context. Subsequent compactions preserve and augment the existing summary.

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
- Shows pagination hints when truncated

```js
const content = await read({ path: 'data/config.json' })
// Shows: [Showing lines 1-50 of 200. Use offset=51 to continue.]
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
- `path` (string): Relative path
- `base64` (string): Base64-encoded content

#### `readBinary({ path })`
Read a binary file. The file is automatically attached to the response as an image/file.
- `path` (string): Relative path
- Max size: 20MB
- Returns: `{ base64, mimeType, size }`

#### `edit({ path, oldText, newText })`
Surgical text replacement in a file. Requires exact match.
- `path` (string): Relative path
- `oldText` (string): Exact text to find (case-sensitive, whitespace-sensitive)
- `newText` (string): Replacement text
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
- `path` (string, optional): Directory path (default: `.`)
- `limit` (number, optional): Max entries (default: 500)
- Returns: Sorted list, directories marked with `/` suffix
- Note: `.agentwfy/` is automatically excluded

#### `mkdir({ path, recursive? })`
Create a directory.
- `recursive` (boolean, optional): Create parent dirs (default: `true`)

#### `remove({ path, recursive? })`
Delete a file or directory.
- `recursive` (boolean, optional): Remove directory contents (default: `false`)

#### `find({ pattern, path?, limit? })`
Find files matching a glob pattern.
- `pattern` (string): Glob pattern (`*`, `**`, `?` supported)
- `path` (string, optional): Starting directory (default: agent root)
- `limit` (number, optional): Max results (default: 1,000)

```js
const files = await find({ pattern: '**/*.json', path: 'data' })
```

#### `grep({ pattern, path?, options? })`
Search file contents with regex.
- `pattern` (string): Regular expression (or literal if `options.literal: true`)
- `path` (string, optional): Search directory (default: agent root)
- `options.ignoreCase` (boolean): Case-insensitive search
- `options.literal` (boolean): Treat pattern as literal string
- `options.context` (number): Lines of context around matches
- `options.limit` (number): Max matches (default: 100)
- Returns: Results in `file:line: content` format

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
- `target` (string): `'agent'` (default) or `'sqlite-file'`
- `sql` (string): SQL query or statement
- `params` (array, optional): Bound parameters (prevents SQL injection)
- `path` (string): Required when target is `'sqlite-file'`
- `description` (string, optional): Human-readable description
- Returns: Array of row objects for SELECT; change info for INSERT/UPDATE/DELETE

```js
// Query agent database
const docs = await runSql({
  sql: 'SELECT name, content FROM docs WHERE name NOT LIKE "%.%" ORDER BY name'
})

// Use parameterized queries
const tasks = await runSql({
  sql: 'SELECT * FROM tasks WHERE name LIKE ?',
  params: ['%report%']
})

// Work with external SQLite files
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

Tabs display views, files, and URLs in the main content area.

#### `getTabs()`
Get all open tabs with their state.
- Returns: `{ tabs: [{ id, title, viewId, viewUpdatedAt, viewChanged, pinned, hidden, selected }] }`

#### `openTab({ viewId?, viewName?, filePath?, url?, title?, hidden?, params? })`
Open a new tab. Exactly **one** of `viewId`, `viewName`, `filePath`, or `url` is required.
- `viewId` (string|number): Open a database view by ID
- `viewName` (string): Open a database view by name (auto-resolves to ID)
- `filePath` (string): Open a local HTML file
- `url` (string): Open a URL
- `title` (string, optional): Tab title
- `hidden` (boolean, optional): Create a hidden tab (useful for automation)
- `params` (object, optional): Query parameters passed to the view
- Returns: `{ tabId }`

```js
// Open a database view
await openTab({ viewName: 'system.docs' })

// Open a local file
await openTab({ filePath: 'output/dashboard.html', title: 'Dashboard' })

// Open with parameters
await openTab({ viewName: 'my-report', params: { month: '2025-03' } })

// Hidden tab for automation
const { tabId } = await openTab({ url: 'https://example.com', hidden: true })
const screenshot = await captureTab({ tabId })
await closeTab({ tabId })
```

#### `closeTab({ tabId })`
Close a tab.

#### `selectTab({ tabId })`
Make a tab active/visible.

#### `reloadTab({ tabId })`
Refresh a tab's content.

#### `captureTab({ tabId })`
Take a screenshot of a tab. The image is automatically attached to the agent response.
- Returns: `{ base64, mimeType }` (typically `image/png`)

#### `getTabConsoleLogs({ tabId, since?, limit? })`
Get browser console output from a tab.
- `since` (number, optional): Unix timestamp to filter from
- `limit` (number, optional): Max entries
- Returns: Array of `{ level: 'verbose'|'info'|'warning'|'error', message, timestamp }`

#### `execTabJs({ tabId, code, timeoutMs? })`
Execute JavaScript **in the browser context** of a tab. This has access to the DOM, unlike regular execJs.
- `tabId` (string): Target tab
- `code` (string): JavaScript code to execute
- `timeoutMs` (number, optional): Timeout (default: 5s, max: 120s)
- Returns: The code's return value

```js
// Read DOM content from a tab
const title = await execTabJs({
  tabId: 'tab-123',
  code: 'document.querySelector("h1").textContent'
})

// Interact with a view's UI
await execTabJs({
  tabId: 'tab-123',
  code: 'document.querySelector("#submit-btn").click()'
})
```

### Event Bus (Pub/Sub)

The event bus enables communication between agents, tasks, views, and triggers.

#### `publish({ topic, data })`
Publish a message to a topic.
- `topic` (string): Topic name
- `data` (unknown): Message payload
- Messages are **consumed**: each publish delivers to exactly one waiter (FIFO)
- If no waiter exists, the message is queued (up to 1,000 messages per topic)

#### `waitFor({ topic, timeoutMs? })`
Wait for a message on a topic.
- `topic` (string): Topic to listen on
- `timeoutMs` (number, optional): Max wait time (default: 120,000ms / 2 minutes)
- Returns: The published data
- Throws on timeout

```js
// Publisher
await publish({ topic: 'data-ready', data: { file: 'report.csv', rows: 1500 } })

// Consumer (in another execJs call, task, or sub-agent)
const result = await waitFor({ topic: 'data-ready', timeoutMs: 30000 })
console.log(result.file) // 'report.csv'
```

**Best practices:**
- Use unique topic names (include session IDs or run IDs) to avoid collisions
- Use for agent-to-task, task-to-task, and view-to-agent communication
- Messages queue if published before anyone is waiting

### Sessions

Spawn sessions that run in parallel with their own execution context.

#### `spawnSession({ prompt })`
Spawn a session with an initial prompt.
- `prompt` (string): Initial message for the session
- Returns: `{ sessionId }` — the session file path
- The session runs independently and publishes its response to `session:response:{sessionId}`

```js
// Spawn and wait for result
const { sessionId } = await spawnSession({ prompt: 'Analyze data/sales.csv and return a JSON summary' })
const response = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 120000 })
```

#### `sendToSession({ sessionId, message })`
Send a follow-up message to a session.
- `sessionId` (string): Session file from `spawnSession`
- `message` (string): Follow-up message
- The session publishes its response to the same `session:response:{sessionId}` topic

```js
// Multi-turn session conversation
const { sessionId } = await spawnSession({ prompt: 'You are a data analyst.' })
await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 60000 })

await sendToSession({ sessionId, message: 'What are the top 5 products by revenue?' })
const answer = await waitFor({ topic: `session:response:${sessionId}`, timeoutMs: 60000 })
```

#### `openSessionInChat({ sessionId })`
Open a spawned session in the main chat panel for interactive use. Works for both running and finished sessions.

### Task Management Functions

#### `startTask({ taskId, input? })`
Start a task from the tasks table.
- `taskId` (number): Task ID from the database
- `input` (unknown, optional): Input data available as `input` variable inside the task
- Returns: `{ runId }` — unique execution identifier

#### `stopTask({ runId })`
Stop a running task.
- `runId` (string): Run ID from `startTask`

### Plugin Management Functions

#### `requestInstallPlugin({ packagePath })`
Request installation of a plugin package (shows confirmation dialog).
- `packagePath` (string): Path to `.plugins.awfy` file
- Returns: `{ installed: string[] }` — list of installed plugin names

#### `requestTogglePlugin({ pluginName })`
Request enabling/disabling a plugin.
- Returns: `{ toggled: boolean, enabled?: boolean }`

#### `requestUninstallPlugin({ pluginName })`
Request removal of a plugin.
- Returns: `{ uninstalled: boolean }`

### Utilities

#### `getAvailableFunctions()`
List all registered functions with their sources.
- Returns: `[{ name: 'read', source: 'built-in' }, { name: 'myPlugin', source: 'my-plugin' }, ...]`

#### `openExternal({ url })`
Open a URL in the user's default browser.
- Only `http://` and `https://` URLs allowed.

---

## Database System

Every agent has its own SQLite database at `.agentwfy/agent.db`. The database has 6 tables, each with specific purposes and access rules.

### Docs Table

**Purpose:** Store documentation, instructions, and knowledge for the agent.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT (UNIQUE) | Document identifier |
| `content` | TEXT | Document content (markdown/plain text) |
| `updated_at` | INTEGER | Unix epoch seconds |

**Namespacing:**
- Names **without dots** (e.g., `instructions`, `knowledge-base`): Automatically preloaded into the agent's system prompt
- `system.*` (e.g., `system.views`, `system.tasks`): Built-in documentation, **read-only**
- `plugin.*` (e.g., `plugin.ffmpeg`, `plugin.ffmpeg.usage`): Plugin documentation, **read-only**
- Other dotted names (e.g., `reference.api`): User docs, available on demand but not preloaded

**12 Built-in System Docs:**
- `system` — Runtime overview and constraints
- `system.views` — View creation, CSS variables, runtime APIs
- `system.config` — Configuration system
- `system.plugins` — Plugin overview
- `system.plugins.dev` — Plugin development API
- `system.plugins.guide` — Plugin management guide
- `system.tasks` — Task system
- `system.triggers` — Trigger types and configuration
- `system.files` — File operation APIs
- `system.tabs` — Tab management
- `system.eventbus` — Event bus pub/sub
- `system.sessions` — Session spawning and interaction

**Example — Shaping Agent Behavior:**

```js
// Give the agent domain knowledge
await runSql({
  sql: `INSERT OR REPLACE INTO docs (name, content) VALUES (?, ?)`,
  params: ['instructions', `
You are a financial data analyst. When presenting numbers:
- Always use 2 decimal places for currency
- Use comma separators for thousands
- Include % change from previous period when available
`]
})
```

### Views Table

**Purpose:** Store HTML/CSS/JS views that render in tabs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT (UNIQUE) | View identifier (lowercase, digits, dots, hyphens, underscores only) |
| `title` | TEXT | Display title |
| `content` | TEXT | HTML/CSS/JS content |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds |

**5 Built-in System Views:**
- `system.settings` — Application settings
- `system.docs` — Documentation browser
- `system.plugins` — Plugin manager
- `system.source-explorer` — File explorer
- `system.openai-compatible-provider.settings-view` — Provider configuration

### Tasks Table

**Purpose:** Define executable JavaScript tasks.

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

**Purpose:** Define when tasks are automatically triggered.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `task_id` | INTEGER | References tasks(id), CASCADE delete |
| `type` | TEXT | `'schedule'`, `'http'`, or `'event'` |
| `config` | TEXT | JSON configuration (type-specific) |
| `description` | TEXT | Human-readable description |
| `enabled` | INTEGER | 1 (active) or 0 (disabled) |
| `created_at` | INTEGER | Unix epoch seconds |
| `updated_at` | INTEGER | Unix epoch seconds |

### Config Table

**Purpose:** Agent-level settings with a three-tier resolution.

| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT (PK) | Setting key |
| `value` | TEXT | String value, or NULL to use global/default |
| `description` | TEXT | Human-readable description |

**Resolution order:** Agent DB value (non-NULL) > Global Electron store > Hardcoded default

### Plugins Table

**Purpose:** Registry of installed plugins. **Entirely read-only** for agents.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `name` | TEXT (UNIQUE) | Plugin name |
| `description` | TEXT | Plugin description |
| `version` | TEXT | Version string |
| `code` | TEXT | Plugin JavaScript source |
| `author` | TEXT | Author name |
| `repository` | TEXT | Source repository URL |
| `license` | TEXT | License type |
| `enabled` | INTEGER | 1 (active) or 0 (disabled) |

---

## Views System

Views are HTML pages that render in tabs within the AgentWFY window. They're the primary way agents build user interfaces — dashboards, forms, data tables, charts, and interactive tools.

### Two Types of Views

1. **Database views**: Stored in the `views` table. Opened via `openTab({ viewId })` or `openTab({ viewName: 'my-view' })`.
2. **File views**: HTML files on disk. Opened via `openTab({ filePath: 'output/page.html' })`.

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
    h1 { color: var(--color-text4); }
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
// In a view's <script> tag:
const data = await agentwfy.runSql({ sql: 'SELECT * FROM docs' })
await agentwfy.write({ path: 'export.json', content: JSON.stringify(data) })
await agentwfy.publish({ topic: 'view-action', data: { action: 'refresh' } })
```

### CSS Design Tokens

Views automatically have access to CSS custom properties that match the app's theme and switch between light and dark mode:

**Backgrounds:** `--color-bg1`, `--color-bg2`, `--color-bg3`, `--color-surface`
**Text:** `--color-text1` (muted), `--color-text2` (secondary), `--color-text3` (primary), `--color-text4` (strong)
**UI:** `--color-border`, `--color-divider`, `--color-accent`, `--color-focus-border`
**Semantic:** `--color-red-bg`, `--color-red-fg`, `--color-green-bg`, `--color-green-fg`, `--color-yellow-bg`, `--color-yellow-fg`
**Input:** `--color-input-bg`, `--color-input-border`
**Code:** `--color-code-bg`
**Typography:** `--font-family`, `--font-mono`
**Layout:** `--radius-sm` (4px), `--radius-md` (6px)
**Motion:** `--transition-fast` (120ms), `--transition-normal` (200ms)

### View Parameters

Pass data to views via URL parameters:

```js
// Open with parameters
await openTab({ viewName: 'invoice-viewer', params: { invoiceId: '42' } })
```

```js
// Read parameters inside the view
const params = new URLSearchParams(window.location.search)
const invoiceId = params.get('invoiceId')
```

### Hidden Tabs for Automation

Create hidden tabs for background work:

```js
// Open hidden tab for scraping
const { tabId } = await openTab({ url: 'https://example.com/data', hidden: true })

// Wait for page load, then extract data
const data = await execTabJs({ tabId, code: 'document.querySelector(".results").innerText' })

// Screenshot for verification
const screenshot = await captureTab({ tabId })

// Clean up
await closeTab({ tabId })
```

### Tab Features

- **Pin/unpin**: Pinned tabs stay on the left and show only their icon
- **Drag to reorder**: Tabs support drag-and-drop reordering
- **Middle-click to close**: Quick close for unpinned tabs
- **Right-click context menu**: Pin, reload, open DevTools
- **Change indicator**: A dot appears when a view's content has been updated in the database
- **Hidden tabs**: Collapsed into a toggle button with count badge

---

## Tasks & Automation

Tasks are reusable JavaScript scripts stored in the database that can be triggered manually, on a schedule, via HTTP, or by events.

### Creating a Task

```js
await runSql({
  sql: `INSERT INTO tasks (name, description, content, timeout_ms) VALUES (?, ?, ?, ?)`,
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
    30000  // 30 second timeout
  ]
})
```

### Running a Task

**From the agent:**
```js
const { runId } = await startTask({ taskId: 1, input: { date: '2025-03-26' } })
```

**From the command palette:** Open the command palette (`Cmd+K`), go to Tasks, and click Run.

**From the Task Panel:** Click the Tasks button in the sidebar, find your task, and click Run.

### Task Input

The `input` parameter is available as a global variable inside task code:

```js
// Task code
const targetDate = input?.date || new Date().toISOString().slice(0, 10)
const rows = await runSql({
  sql: 'SELECT * FROM events WHERE date = ?',
  params: [targetDate]
})
return rows
```

Input sources vary by trigger type:
- **Manual/agent**: Whatever is passed to `startTask`
- **HTTP trigger**: The HTTP request object `{ method, path, headers, query, body }`
- **Event trigger**: The published event data
- **Schedule trigger**: The `config.input` value (if set)

### Task Completion Events

Every task publishes its result to the event bus when done:

```js
// Start task and wait for completion
const { runId } = await startTask({ taskId: 1 })
const result = await waitFor({ topic: `task:run:${runId}`, timeoutMs: 60000 })
// result = { runId, taskId, name, status: 'completed', result: ..., logs: [...] }
```

### Task Panel UI

The sidebar Task Panel has three tabs:

- **Runs**: Shows live running tasks (green pulse) and history grouped by date
- **Tasks**: Lists all defined tasks with Run buttons and input fields
- **Triggers**: Shows all triggers with enable/disable toggles and configuration details

Each run entry shows status (success/failure), duration, origin (agent/trigger/manual), and is expandable to view logs, input, and output.

---

## Triggers

Triggers define when and how tasks are automatically executed. There are three types.

### Schedule Triggers (Cron)

Execute tasks on a time-based schedule using 6-field cron expressions.

**Format:** `second minute hour day month weekday`

| Field | Range | Special |
|-------|-------|---------|
| second | 0-59 | `*`, ranges, lists, steps |
| minute | 0-59 | `*`, ranges, lists, steps |
| hour | 0-23 | `*`, ranges, lists, steps |
| day | 1-31 | `*`, ranges, lists, steps |
| month | 1-12 | `*`, ranges, lists, steps |
| weekday | 0-6 (0=Sun) | `*`, ranges, lists, steps |

**Examples:**
- `0 */5 * * * *` — Every 5 minutes
- `0 0 9 * * 1-5` — 9:00 AM, weekdays only
- `0 30 14 * * *` — 2:30 PM daily
- `*/30 * * * * *` — Every 30 seconds
- `0 0 0 1 * *` — Midnight on the 1st of each month

```js
// Create a task
const result = await runSql({
  sql: `INSERT INTO tasks (name, description, content) VALUES (?, ?, ?) RETURNING id`,
  params: ['cleanup', 'Remove old temp files', `
    const files = await find({ pattern: '**/*', path: '.tmp' })
    // Delete files older than 7 days
    return { cleaned: files.split('\\n').filter(Boolean).length }
  `]
})

// Attach a schedule trigger
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'schedule', ?, ?)`,
  params: [result[0].id, JSON.stringify({ expression: '0 0 3 * * *' }), 'Run cleanup at 3 AM daily']
})
```

### HTTP Triggers

Expose tasks as REST endpoints on the local HTTP API server.

**Config:** `{ "path": "/my-endpoint", "method": "POST", "input": ... }`

- `path`: Route path (e.g., `/webhook` or `webhook`)
- `method`: HTTP method (default: `POST`)
- `input`: If set, this static value is passed as input. If not set, the HTTP request body is used.

```js
// Create a webhook task
const result = await runSql({
  sql: `INSERT INTO tasks (name, description, content, timeout_ms) VALUES (?, ?, ?, ?) RETURNING id`,
  params: ['process-webhook', 'Process incoming webhook', `
    const data = input
    await runSql({
      sql: 'INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)',
      params: [data.body?.type || 'unknown', JSON.stringify(data.body), Date.now()]
    })
    return { processed: true }
  `, 30000]
})

// Attach HTTP trigger
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'http', ?, ?)`,
  params: [result[0].id, JSON.stringify({ path: '/webhook', method: 'POST' }), 'Webhook endpoint']
})
```

Now `POST http://localhost:9877/webhook` will trigger the task with the request body as input.

**HTTP Response Format:**
- Success: `{ "ok": true, "data": <task return value> }`
- Timeout (120s): `{ "ok": false, "error": "Task execution timeout" }` (504)
- Error: `{ "ok": false, "error": "<error message>" }` (500)

### Event Triggers

React to internal event bus messages, including file system changes.

**Config:** `{ "topic": "my-topic", "input": ... }`

```js
// Trigger when a custom event is published
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'event', ?, ?)`,
  params: [taskId, JSON.stringify({ topic: 'data-imported' }), 'Process new data imports']
})
```

### File Watcher Events

A special event topic pattern enables file system watching:

**Pattern:** `file:<event>:<directory>`

| Event | Fires When |
|-------|-----------|
| `file:created:<dir>` | New file created in directory |
| `file:deleted:<dir>` | File deleted from directory |
| `file:changed:<dir>` | File modified in directory |

```js
// Watch for new files in uploads/ directory
await runSql({
  sql: `INSERT INTO triggers (task_id, type, config, description) VALUES (?, 'event', ?, ?)`,
  params: [
    taskId,
    JSON.stringify({ topic: 'file:created:uploads' }),
    'Process new uploads'
  ]
})
```

The task receives: `{ event: 'created', filename: 'report.csv', path: 'uploads/report.csv' }`

**Notes:**
- Watches are non-recursive (direct children only)
- Debounced at 200ms to handle partial writes
- Multiple triggers on the same directory share one watcher
- Directory is auto-created if it doesn't exist

### Trigger Management

Triggers auto-reload whenever the `triggers` table changes (debounced 500ms). You can enable/disable triggers without deleting them:

```js
// Disable a trigger
await runSql({ sql: 'UPDATE triggers SET enabled = 0 WHERE id = ?', params: [triggerId] })

// Re-enable
await runSql({ sql: 'UPDATE triggers SET enabled = 1 WHERE id = ?', params: [triggerId] })

// Delete (cascades if task deleted too)
await runSql({ sql: 'DELETE FROM triggers WHERE id = ?', params: [triggerId] })
```

---

## HTTP API

AgentWFY runs a local HTTP server for external integrations.

### Server Details

- **Default port:** 9877 (configurable via `system.httpApi.port` config)
- **CORS:** Enabled for all origins (`Access-Control-Allow-Origin: *`)
- **Max body size:** 10 MB
- **Lockfile:** `.agentwfy/http-api.pid` records `{ "port": 9877, "pid": 12345 }`

### Built-in Endpoints

#### `GET /files/{relative_path}`
Serve files from the agent directory with correct MIME types.

```bash
curl http://localhost:9877/files/data/report.json
```

Security: Paths are validated to stay within the agent root directory.

#### Dynamic Endpoints (from HTTP triggers)
Any HTTP trigger creates a corresponding REST endpoint.

### Discovering the Port

External tools can read the lockfile to discover the API port:

```bash
cat /path/to/agent/.agentwfy/http-api.pid
# {"port":9877,"pid":12345}
```

The lockfile includes the PID so stale lockfiles from crashed processes can be detected and cleaned up.

---

## Plugin System

Plugins extend AgentWFY with new functions, LLM providers, documentation, views, and configuration.

### Using Plugins

**Installing a plugin:**
1. Open the command palette (`Cmd+K`)
2. Select "Install Plugin"
3. Choose a `.plugins.awfy` package file
4. Confirm the installation

Or via the agent:
```js
await requestInstallPlugin({ packagePath: '/path/to/my-plugin.plugins.awfy' })
```

**Managing plugins:**
- Open the command palette and go to Plugins, or open the `system.plugins` view
- Toggle plugins on/off (requires restart to take effect)
- Uninstall removes all plugin data (docs, views, config, assets)

### Plugin Package Format

A plugin package (`.plugins.awfy`) is a SQLite database containing:

| Table | Purpose |
|-------|---------|
| `plugins` | Plugin code and metadata (1+ rows) |
| `docs` | Documentation (0+ rows, named `plugin.<name>.*`) |
| `views` | HTML views (0+ rows, named `plugin.<name>.*`) |
| `config` | Default settings (0+ rows, named `plugin.<name>.*`) |
| `assets` | Binary files (0+ rows, extracted to `plugin-assets/`) |

A single package can contain multiple plugins.

### Developing Plugins

#### Plugin Entry Point

Every plugin must export an `activate(api)` function:

```js
module.exports = {
  activate(api) {
    // Register functions, providers, etc.

    // Optional: return a deactivate function for cleanup
    return () => {
      // Clean up timers, child processes, connections, etc.
    }
  }
}
```

#### Plugin API

The `api` object provides:

| Method | Description |
|--------|-------------|
| `api.agentRoot` | Absolute path to the agent's data directory |
| `api.assetsDir` | Path to `.agentwfy/plugin-assets/<plugin-name>/` |
| `api.registerFunction(name, handler)` | Register a function callable from execJs and views |
| `api.registerProvider(factory)` | Register a custom LLM provider |
| `api.publish(topic, data)` | Publish to the event bus |
| `api.getConfig(name, fallback?)` | Read a config value (JSON-parsed) |
| `api.setConfig(name, value)` | Write a config value (JSON-serialized) |

#### Registering Functions

```js
module.exports = {
  activate(api) {
    api.registerFunction('myPluginTransform', async (params) => {
      const { text, format } = params
      // Full Node.js access: require('fs'), require('child_process'), etc.
      const result = processData(text, format)
      return { transformed: result, timestamp: Date.now() }
    })
  }
}
```

Function handlers:
- Run in the **main Electron process** (not in the sandboxed worker)
- Have full `require()` access to Node.js built-in and npm modules
- Must return JSON-serializable data
- Are async (`(params) => Promise<unknown>`)

**Naming convention:** Prefix function names with your plugin name to avoid collisions (e.g., `myPluginDoSomething`).

#### Example: Echo Plugin

```js
// plugins/echo/src/index.js
module.exports = {
  activate(api) {
    api.registerFunction('echoTest', async (params) => {
      return { echoed: params, timestamp: Date.now() }
    })

    api.registerFunction('echoRepeat', async (params) => {
      const text = params?.text ?? ''
      const count = params?.count ?? 3
      return { repeated: Array(count).fill(text).join(' ') }
    })
  }
}
```

### Custom LLM Providers via Plugins

Plugins can register full LLM providers that appear alongside the built-in OpenAI-compatible provider.

#### Provider Factory

```js
module.exports = {
  activate(api) {
    api.registerProvider({
      id: 'my-llm',
      name: 'My Custom LLM',
      settingsView: 'plugin.my-llm.settings',  // Optional: view for config UI

      getStatusLine() {
        const model = api.getConfig('plugin.my-llm.modelId', 'default-model')
        return model
      },

      createSession(config) {
        return new MySession(config, api)
      },

      restoreSession(config, state) {
        return new MySession(config, api, state)
      }
    })
  }
}
```

#### Provider Session

A provider session must implement:

```js
class MySession {
  constructor(config, api, savedState) {
    this.listeners = new Set()
    this.messages = savedState?.displayMessages || []
    this.systemPrompt = config.systemPrompt
    this.tools = config.tools
  }

  send(event) {
    switch (event.type) {
      case 'user_message':
        this.handleUserMessage(event.text, event.files)
        break
      case 'exec_js_result':
        this.handleToolResult(event.id, event.content, event.isError)
        break
      case 'abort':
        this.handleAbort()
        break
    }
  }

  on(listener) { this.listeners.add(listener) }
  off(listener) { this.listeners.delete(listener) }

  emit(event) {
    for (const listener of this.listeners) listener(event)
  }

  getDisplayMessages() { return this.messages }
  getState() { return { displayMessages: this.messages, /* internal state */ } }
  getTitle() { return this.messages[0]?.blocks[0]?.content?.slice(0, 100) }

  async handleUserMessage(text, files) {
    // 1. Add user message to history
    // 2. Call your LLM API
    // 3. Stream response via emit():
    this.emit({ type: 'start' })
    this.emit({ type: 'text_delta', delta: 'Hello...' })
    // Request tool calls:
    this.emit({ type: 'exec_js', id: 'call-1', description: 'Read file', code: 'await read({path:"data.txt"})' })
    // When done:
    this.emit({ type: 'done' })
    this.emit({ type: 'state_changed' })
  }
}
```

**Output events to emit:**
- `{ type: 'start' }` — Response stream beginning
- `{ type: 'text_delta', delta: '...' }` — Text chunk
- `{ type: 'thinking_delta', delta: '...' }` — Reasoning/thinking chunk
- `{ type: 'exec_js', id, description, code }` — Request tool execution
- `{ type: 'done' }` — Response complete
- `{ type: 'error', error: '...' }` — Error occurred
- `{ type: 'status_line', text: '...' }` — Update status display
- `{ type: 'state_changed' }` — Commit state for persistence

---

## Publishing Plugins & Agents

Plugins and agents are distributed through the AgentWFY registry. Users discover and install them from the **Browse Plugins** and **Browse Agents** tabs in the `system.plugins` view.

### Browsing & Installing from the Registry

Open the `system.plugins` view (via command palette or by asking the agent) to access three tabs:

- **Installed Plugins** — manage plugins already in the agent
- **Browse Plugins** — search and install plugins from the registry
- **Browse Agents** — search and install agent templates from the registry

Clicking **Install** downloads the package and installs it into the current agent. Installed plugins can be toggled on/off or uninstalled from the Installed tab.

### Building a Plugin Package

A plugin project has this structure:

```
my-plugin/
├── package.json       # metadata (name must start with agentwfy-plugin-)
├── build.mjs          # build script
├── src/
│   └── index.js       # plugin code (exports activate)
├── docs/              # optional markdown docs
├── views/             # optional HTML views
└── config/
    └── config.json    # optional default settings
```

**package.json** provides the metadata embedded into the package:

```json
{
  "name": "agentwfy-plugin-my-plugin",
  "version": "1.0.0",
  "description": "What it does",
  "author": "your-name",
  "license": "MIT",
  "repository": "https://github.com/you/my-plugin"
}
```

The plugin name in the registry is derived by stripping the `agentwfy-plugin-` prefix (e.g., `agentwfy-plugin-my-plugin` becomes `my-plugin`).

**build.mjs** compiles everything into a `.plugins.awfy` SQLite package:

```js
#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const root = import.meta.dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const pluginName = pkg.name.replace('agentwfy-plugin-', '');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const outPath = path.join(dist, `${pluginName}.plugins.awfy`);
try { fs.unlinkSync(outPath); } catch {}

const db = new DatabaseSync(outPath);

db.exec(`
  CREATE TABLE plugins (name TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL, code TEXT NOT NULL, author TEXT, repository TEXT, license TEXT);
  CREATE TABLE docs (name TEXT NOT NULL, content TEXT NOT NULL);
  CREATE TABLE views (name TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
  CREATE TABLE config (name TEXT NOT NULL, value TEXT, description TEXT NOT NULL DEFAULT '');
`);

const code = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf-8');
db.prepare('INSERT INTO plugins VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  pluginName, pkg.description, pkg.version, code,
  pkg.author || null, pkg.repository || null, pkg.license || null
);

// Docs
const docsDir = path.join(root, 'docs');
if (fs.existsSync(docsDir)) {
  for (const file of fs.readdirSync(docsDir).filter(f => f.endsWith('.md'))) {
    const name = `plugin.${pluginName}.${file.replace(/\.md$/, '')}`;
    const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
    db.prepare('INSERT INTO docs VALUES (?, ?)').run(name, content);
  }
}

// Views
const viewsDir = path.join(root, 'views');
if (fs.existsSync(viewsDir)) {
  for (const file of fs.readdirSync(viewsDir).filter(f => f.endsWith('.html'))) {
    const viewName = `plugin.${pluginName}.${file.replace(/\.html$/, '')}`;
    const content = fs.readFileSync(path.join(viewsDir, file), 'utf-8');
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : viewName;
    db.prepare('INSERT INTO views VALUES (?, ?, ?)').run(viewName, title, content);
  }
}

// Config
const configFile = path.join(root, 'config', 'config.json');
if (fs.existsSync(configFile)) {
  for (const entry of JSON.parse(fs.readFileSync(configFile, 'utf-8'))) {
    db.prepare('INSERT INTO config VALUES (?, ?, ?)').run(
      entry.name, entry.value ?? null, entry.description || ''
    );
  }
}

db.close();
console.log(`Built: ${outPath}`);
```

Run `node build.mjs` to produce `dist/my-plugin.plugins.awfy`.

### Publishing a Plugin to the Registry

Registry repository: [github.com/AgentWFY/plugins](https://github.com/AgentWFY/plugins)

1. **Build** your `.plugins.awfy` package
2. **Upload** the package as a GitHub Release asset in your plugin's repository
3. **Open an issue** in [AgentWFY/plugins](https://github.com/AgentWFY/plugins/issues/new/choose) using the **Publish Plugin** template — provide the HTTPS download URL to the release asset
4. A maintainer reviews and adds the `approved` label
5. A GitHub Actions workflow automatically validates the package (checks required fields, license, no duplicates) and adds it to the registry

**Validation requirements:**
- Package must contain exactly one plugin
- Required fields: `name`, `description`, `version`, `author`, `license`
- Accepted licenses: MIT, Apache-2.0, GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, BSD-2-Clause, BSD-3-Clause, MPL-2.0, ISC, Unlicense, CC0-1.0

**Updating a plugin:** Open an issue using the **Update Plugin** template with the new download URL. The version must be higher than the existing one. Only the original publisher can update.

**Removing a plugin:** Open an issue using the **Remove Plugin** template with the plugin name and reason. Only the original publisher can remove.

### Building an Agent Package

An agent package (`.agent.awfy`) is a SQLite database that must contain at least a `views` and `docs` table. It can also include `tasks` and `plugins` tables.

To create a shareable agent, export its database content into the `.agent.awfy` format with the required tables.

### Publishing an Agent to the Registry

Registry repository: [github.com/AgentWFY/agents](https://github.com/AgentWFY/agents)

1. **Upload** the `.agent.awfy` file as a GitHub Release asset
2. **Open an issue** in [AgentWFY/agents](https://github.com/AgentWFY/agents/issues/new/choose) using the **Publish Agent** template — provide the agent name, description, author, and download URL
3. A maintainer reviews and adds the `approved` label
4. A GitHub Actions workflow validates the file (checks for required `views` and `docs` tables) and adds it to the registry

**Updating an agent:** Open an issue using the **Update Agent** template. Only the original publisher can update.

**Removing an agent:** Open an issue using the **Remove Agent** template. Only the original publisher can remove.

---

## Provider System

### Built-in: OpenAI Compatible

The built-in provider works with any OpenAI-compatible API endpoint.

**Supported services:**
- **OpenRouter** (default): Access 100+ models through one API key
- **DeepSeek**: Direct API access
- **Groq**: Ultra-fast inference
- **Local models**: Ollama, LM Studio, vLLM, or any local server
- Any service implementing `/v1/chat/completions` with streaming

**Configuration:**

| Setting | Default | Description |
|---------|---------|-------------|
| `system.openai-compatible-provider.baseUrl` | `https://openrouter.ai/api` | API base URL |
| `system.openai-compatible-provider.modelId` | `deepseek/deepseek-v3.2` | Model identifier |
| `system.openai-compatible-provider.apiKey` | (none) | Bearer token |
| `system.openai-compatible-provider.reasoning` | off | Reasoning effort: `off`, `low`, `medium`, `high` |

**Reasoning/Thinking:** When enabled, the provider sends a `reasoning.effort` parameter and displays thinking blocks in the chat. Models that support extended thinking (like DeepSeek R1) will show their reasoning process.

**Retry Logic:** Automatically retries on transient errors (408, 429, 5xx) with exponential backoff, up to 2 retries. Respects `retry-after` headers.

**Status Line:** Shows the model ID, reasoning effort (if enabled), and input token count after each response.

---

## Configuration Reference

### System Settings

All settings are stored in the `config` table and can be modified via SQL or the settings UI.

| Setting | Default | Description |
|---------|---------|-------------|
| `system.defaultView` | `home` | View to open on startup |
| `system.provider` | `openai-compatible` | Active LLM provider ID |
| `system.httpApi.port` | `9877` | HTTP API port (restart required) |
| `system.backup.intervalHours` | `24` | Auto-backup frequency in hours |
| `system.backup.maxCount` | `5` | Max backups to retain |
| `system.cleanup.sessionRetentionDays` | `30` | Days to keep old sessions (0 = forever) |
| `system.cleanup.taskLogRetentionDays` | `30` | Days to keep task logs (0 = forever) |
| `system.openai-compatible-provider.apiKey` | (none) | API key for built-in provider |
| `system.openai-compatible-provider.modelId` | `deepseek/deepseek-v3.2` | Model to use |
| `system.openai-compatible-provider.baseUrl` | `https://openrouter.ai/api` | API endpoint |
| `system.openai-compatible-provider.reasoning` | `off` | Reasoning effort level |

### Modifying Settings

```js
// Change via SQL
await runSql({
  sql: "UPDATE config SET value = ? WHERE name = ?",
  params: ['8080', 'system.httpApi.port']
})

// Revert to default
await runSql({
  sql: "UPDATE config SET value = NULL WHERE name = ?",
  params: ['system.httpApi.port']
})

// Create a custom setting
await runSql({
  sql: "INSERT INTO config (name, value, description) VALUES (?, ?, ?)",
  params: ['my-app.theme', 'dark', 'Custom theme preference']
})
```

### Global vs Agent Settings

Settings have a two-tier system:
- **Global settings**: Apply to all agents (stored in Electron's app data)
- **Agent settings**: Override globals for a specific agent (stored in `agent.db`)

Setting a value to `NULL` in the agent database causes it to fall back to the global setting.

---

## Command Palette

The command palette (`Cmd+K` / `Ctrl+K`) provides quick access to:

- **Views**: Open any system, plugin, or user view
- **Agents**: Open or install agents
- **Plugins**: Install, enable/disable, or uninstall plugins
- **Tasks**: Run tasks with optional input
- **Sessions**: Browse and restore session history
- **Settings**: View and modify all configuration
- **Backups**: List and restore database backups

The palette supports filtered search — type to narrow results.

---

## Keyboard Shortcuts

All shortcuts are configurable via the `config` table. Set to `'disabled'` to unbind.

| Action | Default | Config Key |
|--------|---------|-----------|
| Command Palette | `Cmd+K` / `Ctrl+K` | `system.shortcuts.toggle-command-palette` |
| Toggle AI Chat | `Cmd+I` / `Ctrl+I` | `system.shortcuts.toggle-agent-chat` |
| Toggle Task Panel | `Cmd+J` / `Ctrl+J` | `system.shortcuts.toggle-task-panel` |
| Close Tab | `Cmd+W` / `Ctrl+W` | `system.shortcuts.close-current-tab` |
| Reload Tab | `Cmd+R` / `Ctrl+R` | `system.shortcuts.reload-current-tab` |
| Reload Window | `Cmd+Shift+R` / `Ctrl+Shift+R` | `system.shortcuts.reload-window` |
| Open Agent | `Cmd+O` / `Ctrl+O` | `system.shortcuts.open-agent` |

**In chat:** `Enter` sends message, `Shift+Enter` adds a newline.

---

## Creative Use Cases & Recipes

AgentWFY's combination of AI, code execution, database, views, triggers, HTTP API, and plugins enables a wide range of applications.

### 1. Personal Knowledge Base

Create an agent that stores, organizes, and retrieves your notes using docs and views:

```
You: Create a knowledge base system. I want to save notes with tags and search them.

Agent creates:
- A 'notes' table in the database
- A 'knowledge-base' view with search, tag filtering, and markdown rendering
- Functions to add, edit, and search notes via natural language
```

Ask the agent to "save a note about X" or "find my notes about Y" and it builds the infrastructure for you.

### 2. Data Dashboard

Point the agent at CSV/JSON files and ask it to build interactive dashboards:

```
You: I have sales data in data/sales.csv. Build me a dashboard showing monthly trends,
     top products, and regional breakdown with charts.

Agent:
- Reads the CSV, creates a SQLite table
- Builds a multi-tab dashboard view with Chart.js
- Opens it as a pinned tab
```

### 3. Automated File Processing Pipeline

Use triggers to automatically process files dropped into a directory:

```
You: Watch the 'inbox' folder. When a new PDF appears, extract its text, summarize it,
     and save the summary to 'summaries/'.

Agent creates:
- A task that reads new files, processes them, and writes summaries
- An event trigger watching 'file:created:inbox'
- A view showing all processed files and their summaries
```

### 4. Personal API Server

Expose agent capabilities as HTTP endpoints:

```
You: Create an API endpoint at /api/translate that accepts POST requests with
     { text, targetLanguage } and returns the translation.

Agent creates:
- A task that takes HTTP request input and calls the LLM for translation
- An HTTP trigger on POST /api/translate
- Accessible at http://localhost:9877/api/translate
```

Other services, scripts, or Shortcuts automations can call this API.

### 5. Web Scraping & Monitoring

Use hidden tabs to visit websites and extract data:

```
You: Every hour, check https://example.com/prices, extract the price table,
     and alert me if any price drops more than 10%.

Agent creates:
- A task using openTab with hidden:true, execTabJs to extract prices, captureTab for proof
- A schedule trigger running every hour
- A notification view showing price changes
```

### 6. Multi-Agent Workflows

Decompose complex tasks across specialized sub-agents:

```
You: Analyze my codebase. Spawn three agents: one for security audit,
     one for performance review, one for documentation coverage.
     Combine their findings into a report.

Agent:
- Spawns 3 sub-agents with specialized prompts
- Waits for all responses via event bus
- Synthesizes findings into a comprehensive report view
```

### 7. Custom Chat Interfaces

Build specialized chat UIs in views:

```
You: Create a SQL assistant view. It should have a chat interface where I can ask
     questions about my database in plain English, and it shows the query and results.

Agent creates a view with:
- A chat-like interface
- Uses spawnSession/sendToSession for the backend
- Displays SQL queries and formatted result tables
- Saves query history
```

### 8. Scheduled Reports & Notifications

Automate recurring reporting:

```
You: Every Monday at 9 AM, generate a weekly summary of all tasks completed,
     files changed, and events logged. Save it as a report and notify me.

Agent creates:
- A task that queries activity data and generates a formatted report
- A schedule trigger: '0 0 9 * * 1' (Monday 9 AM)
- A 'weekly-reports' view to browse all past reports
```

### 9. IoT / Home Automation Bridge

Use the HTTP API as a webhook receiver for IoT devices:

```
You: Create endpoints for my smart home. POST /api/sensor with temperature data
     should be logged, and if temp exceeds 30C, create an alert.

Agent creates:
- A sensor data table
- An HTTP trigger that logs readings and checks thresholds
- An alerts view with history
```

### 10. Development Tools

Build custom development tools with full file system access:

```
You: Create a code review tool. It should scan my project for common issues
     (TODO comments, unused imports, large functions) and present a dashboard.

Agent:
- Uses grep and find to scan code
- Creates analysis tables in the database
- Builds an interactive dashboard view with drill-down capability
```

### 11. Custom LLM Provider Plugin

Build a plugin that connects to any LLM API (Anthropic, Google, Cohere, local models):

```js
// plugin code
const Anthropic = require('@anthropic-ai/sdk')

module.exports = {
  activate(api) {
    api.registerProvider({
      id: 'anthropic',
      name: 'Anthropic Claude',
      settingsView: 'plugin.anthropic.settings',
      createSession(config) { return new AnthropicSession(config, api) },
      restoreSession(config, state) { return new AnthropicSession(config, api, state) }
    })
  }
}
```

### 12. Event-Driven Microservices

Chain tasks together using the event bus for complex workflows:

```
You: Build a document processing pipeline:
     1. File uploaded to inbox/ triggers OCR extraction
     2. Extracted text triggers classification
     3. Classification triggers filing to appropriate folder
     4. Filing triggers notification

Agent creates:
- 4 tasks, each publishing to the next task's trigger topic
- Event triggers chaining them together
- A pipeline status view showing each document's progress
```

### 13. Database-Driven Applications

Build full CRUD applications with persistent state:

```
You: Build a project management tool with tasks, milestones, and time tracking.
     I want a Kanban board view and a burndown chart.

Agent creates:
- Database tables for projects, tasks, milestones, time_entries
- A Kanban board view with drag-and-drop (via execTabJs)
- A burndown chart view with Chart.js
- Task automation for deadline notifications
```

### 14. Plugin That Adds External Tool Access

Create a plugin that gives the agent access to external tools:

```js
// FFmpeg plugin example
const { execFile } = require('child_process')

module.exports = {
  activate(api) {
    api.registerFunction('convertVideo', async ({ input, output, format }) => {
      const ffmpegPath = api.assetsDir + '/ffmpeg'
      return new Promise((resolve, reject) => {
        execFile(ffmpegPath, ['-i', input, '-f', format, output], (err, stdout, stderr) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
    })
  }
}
```

### 15. Backup & Sync Automation

Leverage the backup system and add custom sync:

```
You: Set up daily backups and sync important data to my Dropbox folder.

Agent:
- Configures system.backup.intervalHours to 12
- Creates a task that copies key files to ~/Dropbox/agent-backup/
- Attaches a schedule trigger for daily sync
```

---

## Tech Stack

- **[Electron](https://www.electronjs.org/)** — Cross-platform desktop runtime (nightly v41+)
- **[TypeScript](https://www.typescriptlang.org/)** — Strict type-checking with `noImplicitAny`
- **[esbuild](https://esbuild.github.io/)** — Fast bundler for 8 separate entry points (main, renderer, preload scripts, exec worker, command palette, confirmation dialog, welcome window)
- **[SQLite](https://www.sqlite.org/)** (via better-sqlite3) — Per-agent embedded database
- **[Web Components](https://developer.mozilla.org/en-US/docs/Web/API/Web_Components)** — Framework-free UI with Shadow DOM scoping and custom EventBus pub/sub
- **ESM** — ES modules throughout (`"type": "module"`)

---

## Releasing

To publish a new version:

```bash
# 1. Bump version (updates package.json and creates a git tag)
npm version patch   # 1.0.0 → 1.0.1 (bug fixes)
npm version minor   # 1.0.0 → 1.1.0 (new features)
npm version major   # 1.0.0 → 2.0.0 (breaking changes)

# 2. Push the commit and tag
git push origin master --tags
```

GitHub Actions automatically builds for all platforms and creates a **draft release** with:
- **macOS**: `.dmg` installer + `.zip` (arm64 and x64)
- **Linux**: `.deb` package (x64)
- **Windows**: `Setup.exe` installer (x64)

Go to [Releases](https://github.com/AgentWFY/AgentWFY/releases), edit the draft, add release notes, and click **Publish**.

Once published, running apps will detect the update within 4 hours (or immediately via the menu: AgentWFY → Check for Updates).

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Build (`./scripts/build`) — this includes full type checking
5. Test your changes — see [TESTING.md](TESTING.md) for how to interact with the running app programmatically
6. Commit your changes
7. Push to your branch and open a Pull Request

---

## License

MIT
