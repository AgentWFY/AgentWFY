# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentWFY is an Electron desktop app with an AI agent that can interact with a local SQLite database and render views in tabs. The agent uses a custom `Agent` class (`src/renderer/src/agent/index.ts`) for the LLM tool-calling loop with zero external LLM dependencies — streaming, OAuth, and model config are all implemented in-house.

## Commands

- `npm run dev` — Start dev mode (esbuild watch + Electron, reload with Cmd+R)
- `npm run build` — Full production build (esbuild bundles everything)
- `npm run lint` — Type-check all TypeScript files (tsc --noEmit)
- `npm start` — Launch Electron from dist/

## Architecture

### Process Model

- **Main process** (`src/main.ts`): Electron window management, IPC handlers, SQLite, custom protocols (`app://`, `agentview://`), file I/O, security enforcement
- **Renderer process** (`src/renderer/`): UI built with vanilla Web Components, agent session management, esbuild-bundled
- **Web Workers** (`src/renderer/src/runtime/exec_worker.ts`): Agent JS runtime runs in a dedicated worker

### Build System

Single unified esbuild script (`scripts/build.mjs`) bundles all 5 entry points:
- `src/main.ts` → `dist/main.js` (Node/ESM, electron external)
- `src/preload.cts` → `dist/preload.cjs` (Node/CJS, electron external)
- `src/command-palette/preload.cts` → `dist/command-palette/preload.cjs` (Node/CJS)
- `src/renderer/src/index.ts` → `dist/client/index.js` (browser/ESM)
- `src/renderer/src/runtime/exec_worker.ts` → `dist/client/exec_worker.js` (browser/ESM)

Static assets (HTML, CSS) are copied to dist/. One `tsconfig.json` for type checking only (`noEmit: true`, module NodeNext).

### IPC Channels

All IPC flows through `src/preload.cts` which exposes two global APIs:
- `window.agentwfy` — Agent tool operations: file ops (read/write/writeBinary/edit/ls/mkdir/remove/find/grep), SQL queries, tab management, event bus, agent spawning
- `window.electronClientTools` — App operations: dialogs, store, sessions, auth, external views

Channel prefixes: `agentwfy:*` (agent tools), `app:*` (app-level), `bus:*` (event bus), `electronExternalView:*` (view management), `dialog:*`, `electron-store:*`

### UI Framework

Custom Web Components (no React/Vue). Components are in `src/renderer/src/components/` with `awfy-` prefix:
- `awfy-app` — Root shell: header (sidebar buttons + tab bar) + sidebar + main tab area
- `awfy-tabs` — Tab management with external BrowserWindow views
- `awfy-agent-chat` — Chat interface for the AI agent

Components use direct DOM manipulation (no virtual DOM), class properties for local state, and CustomEvents for communication.

### Event Bus

`src/renderer/src/event-bus.ts` provides pub/sub with message queuing. `bus-bridge.ts` bridges IPC ↔ EventBus. Key events: `agentwfy:toggle-agent-chat`, `agentwfy:open-view`, `agentwfy:views-db-changed`, `agentwfy:remove-current-tab`, `agentwfy:refresh-view`.

### Agent System

- `Agent` (`src/renderer/src/agent/index.ts`): Core LLM tool-calling loop with streaming, steering, and follow-up message support
- `AgentWFYAgent` (`src/renderer/src/agent/create_agent.ts`): Higher-level wrapper with session persistence (`.agentwfy/sessions/`), auto-compaction on context overflow, model/thinking-level management
- `AgentSessionManager` (`src/renderer/src/agent/session_manager.ts`): Manages concurrent agent sessions
- Streaming (`src/renderer/src/agent/streaming/`): Own SSE parser and provider-specific streaming for OpenAI-compatible, Anthropic Messages, and OpenAI Codex Responses APIs
- OAuth (`src/renderer/src/agent/oauth/`): Own PKCE implementation, Anthropic OAuth, OpenAI Codex OAuth
- Models (`src/renderer/src/agent/models.ts`): Config-driven model/provider registry loaded from `.agentwfy/models.json` (user-editable)
- System prompt is loaded from SQLite `docs` table (rows with `preload = 1`)
- Default provider: `openrouter`, default model: `deepseek/deepseek-v3.2`
- 3 provider types: Anthropic (OAuth), OpenAI Codex (OAuth), OpenAI-compatible (API key — OpenRouter, DeepSeek, etc.)

### Database

Node.js built-in `sqlite` module (not better-sqlite3). Schema in `src/db/sqlite.ts`:
- `views`: id, name, content, created_at, updated_at
- `docs`: id, name, content, preload, updated_at
- `tasks`: id, name, description, content (JavaScript), timeout_ms, created_at, updated_at
- `triggers`: id, task_id, type (schedule/http/event), config (JSON), description, enabled, created_at, updated_at
- `db_changes`: auto-populated change tracking via triggers

SQL routing (`src/db/sql-router.ts`) supports two targets: `agent` (built-in agent.db) and `sqlite-file` (arbitrary .sqlite files).

### Task System

- `TaskRunner` (`src/renderer/src/tasks/task_runner.ts`): Manages task execution lifecycle — start, stop, log persistence, completion notifications
- Tasks are JavaScript code stored in the `tasks` table, executed in Web Workers via `JsRuntime`
- Task code has access to host methods: `runSql`, `read`, `write`, `writeBinary`, `edit`, `ls`, `mkdir`, `remove`, `find`, `grep`, `getTabs`, `openTab`, `closeTab`, `selectTab`, `reloadTab`, `captureTab`, `getTabConsoleLogs`, `execTabJs`, `publish`, `waitFor`, `fetch`, `WebSocket`, `spawnAgent`, `startTask`, `stopTask`
- Task receives `input` parameter (provided by caller)
- Task logs persisted to `.agentwfy/task_logs/`
- Origins: command-palette, task-panel, agent, trigger, view

### Trigger Engine

`src/triggers/engine.ts` — Loads enabled triggers from DB, sets up handlers, auto-reloads on changes.

Three trigger types:
- **schedule**: Cron-like expressions, fires task at scheduled times
- **http**: Registers dynamic HTTP route on the HTTP API server, executes task with request data as input (`{ method, path, headers, query, body }`), waits up to 120s for response
- **event**: Subscribes to event bus topic, fires task with event data

### HTTP API

`src/http-api/server.ts` — Localhost-only HTTP server (Node built-in `http`, no frameworks). Default port 9877, configured per-agent in `.agentwfy/config.json` (`httpApi.port`). CORS enabled for all origins.

- `GET /files/*` — Static file serving with path security validation
- Dynamic routes registered by trigger engine (HTTP triggers)
- Lockfile at `.agentwfy/http-api.pid` tracks port and process

### Security

`src/security/path-policy.ts` enforces file access sandboxing. The `.agentwfy/` directory has restricted paths. Agent views run under the `agentview://` protocol with a separate, more restricted preload API.

### Design System

Custom CSS design tokens in `src/renderer/src/global.css`.

## No Test Framework

There is currently no test framework configured in this project.
